const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const speedTest = require('speedtest-net');
const sqlite3 = require('sqlite3').verbose();

// Configuration
// Home Assistant stores user configuration in /data/options.json
const optionsPath = '/data/options.json';
let options = {};
if (fs.existsSync(optionsPath)) {
  try {
    options = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
  } catch (err) {
    console.error('Failed to parse options.json, falling back to environment variables', err);
  }
}

const TARGET = options.target_ip || process.env.HA_TARGET || '8.8.8.8';
const PING_COUNT = parseInt(options.ping_count || process.env.HA_PING_COUNT || '4', 10);
const INTERVAL_MS = parseInt(options.interval_seconds || process.env.HA_INTERVAL_SECONDS || '30', 10) * 1000;
const EXTENSIVE_LOGGING = options.extensive_logging === true || process.env.HA_EXTENSIVE_LOGGING === 'true';

// Database Setup: Use /data/ for HA, or local directory for development
const dataDir = fs.existsSync('/data') ? '/data' : __dirname;
const DB_PATH = path.join(dataDir, 'network_tester.db');

const db = new sqlite3.Database(DB_PATH);

// Initialize Database
db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS pings (timestamp TEXT, value REAL)");
  // New table for speed test results
  db.run("CREATE TABLE IF NOT EXISTS speedtests (timestamp TEXT, download REAL, upload REAL, ping REAL)");
});


// Ensure PORT is a valid number and handle potential NaN from env variables or malformed options
const rawPort = options.port || process.env.HA_PORT || '8099'; // Get the raw port value
const parsedPort = parseInt(rawPort, 10); // Attempt to parse it
const PORT = isNaN(parsedPort) ? 8099 : parsedPort; // Use default if parsing failed

if (EXTENSIVE_LOGGING) {
  console.log(`[DEBUG] Port Config - Raw: '${rawPort}', Parsed: ${parsedPort}, Final: ${PORT}`);
}

/**
 * Executes the ping test, parses the output for average RTT, 
 * and saves the result to the database.
 */
function runNetworkTest() {
  const timestamp = new Date().toISOString();
  
  // Using execFile instead of exec to prevent command injection
  // Arguments are passed as an array, avoiding shell interpretation
  execFile('ping', ['-c', String(PING_COUNT), TARGET], (error, stdout, stderr) => {
    if (error) {
      if (EXTENSIVE_LOGGING && stderr) {
        console.error(`[${timestamp}] Ping Stderr: ${stderr.trim()}`);
      }
      console.error(`[${timestamp}] Error pinging ${TARGET}: ${error.message}`);
      return;
    }

    if (EXTENSIVE_LOGGING)
    {
      console.log(`Ping`);
      console.log(stdout);
    }
  
    // Parsing the summary line for the average RTT
    const avgMatch = stdout.match(/=\s+[\d.]+\/([\d.]+)/);
    
    if (avgMatch && avgMatch[1] && !isNaN(parseFloat(avgMatch[1]))) {
      const avgPing = parseFloat(avgMatch[1]);
      
      db.run("INSERT INTO pings (timestamp, value) VALUES (?, ?)", [timestamp, avgPing], (err) => {
        if (err) console.error("DB Insert Error:", err.message);
        
        // Prune database to keep only last 1000 entries
        db.run("DELETE FROM pings WHERE rowid NOT IN (SELECT rowid FROM pings ORDER BY timestamp DESC LIMIT 1000)");
      });

      console.log(`[${timestamp}] Target: ${TARGET}, Avg Ping: ${avgPing} ms`);
    } else {
      if (EXTENSIVE_LOGGING) console.warn(`[${timestamp}] Ping succeeded but summary stats could not be parsed.`);
    }
  });
}

/**
 * Executes an on-demand speed test and saves the results to the database.
 */
async function runSpeedTest() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Starting on-demand speed test...`);

  try {
    const result = await speedTest({ acceptLicense: true, acceptGdpr: true });
    const downloadMbps = (result.download.bandwidth / 125000).toFixed(2); // Convert bytes/sec to Mbps
    const uploadMbps = (result.upload.bandwidth / 125000).toFixed(2);   // Convert bytes/sec to Mbps
    const pingLatency = result.ping.latency.toFixed(2);

    db.run(
      "INSERT INTO speedtests (timestamp, download, upload, ping) VALUES (?, ?, ?, ?)",
      [timestamp, downloadMbps, uploadMbps, pingLatency],
      (err) => {
        if (err) console.error("DB Insert Error (Speedtest):", err.message);

        // Prune speedtests database to keep only last 1000 entries
        db.run("DELETE FROM speedtests WHERE rowid NOT IN (SELECT rowid FROM speedtests ORDER BY timestamp DESC LIMIT 1000)");
      }
    );
    console.log(`[${timestamp}] Speed Test Results: Download: ${downloadMbps} Mbps, Upload: ${uploadMbps} Mbps, Latency: ${pingLatency} ms`);
    return {
      success: true,
      timestamp,
      download: downloadMbps,
      upload: uploadMbps,
      ping: pingLatency
    };
  } catch (err) {
    console.error(`[${timestamp}] Speed Test Error: ${err.message}`);
    if (EXTENSIVE_LOGGING) {
      console.error(`[${timestamp}] Speed Test Details:`, err);
    }
    return { success: false, error: err.message };
  }
}



// Schedule test every 30 seconds and run an initial one immediately
setInterval(runNetworkTest, INTERVAL_MS);
runNetworkTest();

// HTML Dashboard Template
const getHtmlGui = () => `
<!DOCTYPE html>
<html>
<head>
    <title>Network Tester Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { 
            font-family: -apple-system, sans-serif; 
            background: #f0f2f5; 
            padding: 20px; 
            color: #333; /* Default text color for light mode */
        }
        .card { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); max-width: 1000px; margin: auto; }
        h1 { color: #1a73e8; margin-top: 0; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        #chart-wrapper { height: 400px; }
        #speedtest-chart-wrapper { height: 400px; margin-top: 40px; }
        .controls { display: flex; align-items: center; gap: 10px; color: #5f6368; font-size: 0.9em; }
        select { 
            padding: 5px; 
            border-radius: 4px; 
            border: 1px solid #ccc; 
            background-color: white; 
            color: #333; 
        }
        button {
            padding: 8px 15px;
            border-radius: 4px;
            border: none;
            background-color: #1a73e8;
            color: white;
            cursor: pointer;
            font-size: 0.9em;
        }
        button:hover {
            background-color: #1558b3;
        }

        /* Dark Mode Styles */
        @media (prefers-color-scheme: dark) {
            body { 
                background: #1c1c1e; /* Darker background */
                color: #e0e0e0; /* Lighter text color */
            }
            .card { 
                background: #2c2c2e; /* Darker card background */
                box-shadow: 0 4px 6px rgba(0,0,0,0.3); 
            }
            h1 { color: #8ab4f8; } /* Lighter blue for dark mode */
            .controls { color: #b0b0b0; }
            button { background-color: #8ab4f8; }
            button:hover { background-color: #6a9de8; }
            select { background-color: #3a3a3c; border: 1px solid #555; color: #e0e0e0; }
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="header">
            <h1>Latency: ${TARGET}</h1>
            <div class="controls">
                <span>Show:</span>
                <select id="limitSelect" onchange="fetchData()">
                    <option value="20">Last 20</option>
                    <option value="100">Last 100</option>
                    <option value="500">Last 500</option>
                    <option value="1000">Last 1000</option>
                </select>
                <div id="ping-last-update">...</div>
            </div>
        </div>
        <div id="chart-wrapper"><canvas id="pingChart"></canvas></div>

        <div class="header" style="margin-top: 40px;">
            <h1>Speed Test</h1>
            <div class="controls">
                <button onclick="runSpeedTestUI()">Run Speed Test</button>
                <span>Show:</span>
                <select id="speedtestLimitSelect" onchange="fetchSpeedtestData()">
                    <option value="5">Last 5</option>
                    <option value="10">Last 10</option>
                    <option value="20">Last 20</option>
                </select>
                <div id="speedtest-last-update">...</div>
            </div>
        </div>
        <div id="speedtest-chart-wrapper"><canvas id="speedtestChart"></canvas></div>
    </div>
    <script>
        let chart; // Make chart globally accessible within the script

        function getThemeColors() {
            const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            return {
                borderColor: isDarkMode ? '#8ab4f8' : '#1a73e8', // Lighter blue for dark, original for light
                backgroundColor: isDarkMode ? 'rgba(138, 180, 248, 0.1)' : 'rgba(26, 115, 232, 0.1)',
                textColor: isDarkMode ? '#e0e0e0' : '#333', // For labels, etc.
                gridColor: isDarkMode ? 'rgba(224, 224, 224, 0.2)' : 'rgba(0, 0, 0, 0.1)' // Lighter grid for dark mode
            };
        }
        let speedtestChart;

        // Initialize chart
        const ctx = document.getElementById('pingChart').getContext('2d');
        const themeColors = getThemeColors();
        chart = new Chart(ctx, { // Assign to global chart variable
            type: 'line',
            data: { labels: [], datasets: [{
                label: 'Avg Ping (ms)',
                data: [],
                borderColor: themeColors.borderColor,
                backgroundColor: themeColors.backgroundColor,
                fill: true,
                tension: 0.3
            }]},
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: false,
                        min: undefined,
                        max: undefined,
                        ticks: {
                            color: themeColors.textColor // Apply text color to Y-axis ticks
                        },
                        grid: {
                            color: themeColors.gridColor // Apply grid color
                        }
                    },
                    x: {
                        ticks: {
                            color: themeColors.textColor // Apply text color to X-axis ticks
                        },
                        grid: {
                            color: themeColors.gridColor // Apply grid color
                        }
                    }
                },
                plugins: {
                    legend: {
                        labels: {
                            color: themeColors.textColor // Apply text color to legend
                        }
                    }
                }
            }
        });

        // Initialize Speedtest Chart
        const speedtestCtx = document.getElementById('speedtestChart').getContext('2d');
        speedtestChart = new Chart(speedtestCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Download (Mbps)',
                        data: [],
                        borderColor: themeColors.borderColor, // Reusing ping color for download
                        backgroundColor: themeColors.backgroundColor,
                        fill: true,
                        tension: 0.3
                    },
                    {
                        label: 'Upload (Mbps)',
                        data: [],
                        borderColor: '#28a745', // Green for upload
                        backgroundColor: 'rgba(40, 167, 69, 0.1)',
                        fill: true,
                        tension: 0.3
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true, // Speed should start from zero
                        ticks: {
                            color: themeColors.textColor
                        },
                        grid: {
                            color: themeColors.gridColor
                        }
                    },
                    x: {
                        ticks: {
                            color: themeColors.textColor
                        },
                        grid: {
                            color: themeColors.gridColor
                        }
                    }
                },
                plugins: {
                    legend: {
                        labels: {
                            color: themeColors.textColor
                        }
                    }
                }
            }
        });

        // Function to run speed test from UI
        async function runSpeedTestUI() {
            document.getElementById('speedtest-last-update').innerText = 'Running speed test... This may take a minute.';
            const res = await fetch('speedtest/run', { method: 'POST' });
            const result = await res.json();
            if (result.success) {
                fetchSpeedtestData(); // Refresh data after successful test
            } else {
                document.getElementById('speedtest-last-update').innerHTML = '<span style="color: #d93025;">Speed Test Failed: ' + result.error + '</span>';
            }
        }

        async function fetchData() {
            try {
                const limit = document.getElementById('limitSelect').value;
                const res = await fetch('data?limit=' + limit);
                const logs = await res.json();
                chart.data.labels = logs.map(l => new Date(l.t).toLocaleTimeString());
                chart.data.datasets[0].data = logs.map(l => l.v);
                
                if (logs.length > 0) {
                    const values = logs.map(l => l.v);
                    // Ensure there are values to calculate min/max from
                    const minVal = values.length > 0 ? Math.min(...values) : 0;
                    const maxVal = values.length > 0 ? Math.max(...values) : 0;
                    
                    // Set min/max only if there are actual values
                    chart.options.scales.y.min = Math.floor(minVal - 2);
                    chart.options.scales.y.max = Math.ceil(maxVal + 5);
                }

                chart.update('none'); // Update ping chart
                // Update chart colors in case theme changed while data was fetching
                const currentThemeColors = getThemeColors();
                if (chart.data.datasets[0].borderColor !== currentThemeColors.borderColor) {
                    chart.data.datasets[0].borderColor = currentThemeColors.borderColor;
                    chart.data.datasets[0].backgroundColor = currentThemeColors.backgroundColor;
                    chart.options.scales.y.ticks.color = currentThemeColors.textColor;
                    chart.options.scales.x.ticks.color = currentThemeColors.textColor;
                    chart.options.scales.y.grid.color = currentThemeColors.gridColor;
                    chart.options.scales.x.grid.color = currentThemeColors.gridColor;
                    chart.options.plugins.legend.labels.color = currentThemeColors.textColor;
                    chart.update();
                }

                document.getElementById('ping-last-update').innerText = 'Last updated: ' + new Date().toLocaleTimeString();
            } catch (e) { 
                console.error('Update failed', e);
                document.getElementById('ping-last-update').innerHTML = '<span style="color: #d93025;">Connection Error</span>';
            }
        }

        async function fetchSpeedtestData() {
            try {
                const limit = document.getElementById('speedtestLimitSelect').value;
                const res = await fetch('speedtest/data?limit=' + limit);
                const logs = await res.json();

                speedtestChart.data.labels = logs.map(l => new Date(l.t).toLocaleTimeString());
                speedtestChart.data.datasets[0].data = logs.map(l => l.download);
                speedtestChart.data.datasets[1].data = logs.map(l => l.upload);

                speedtestChart.update('none');
                // Update chart colors for speedtest chart
                const currentThemeColors = getThemeColors();
                speedtestChart.options.scales.y.ticks.color = currentThemeColors.textColor;
                speedtestChart.options.scales.x.ticks.color = currentThemeColors.textColor;
                speedtestChart.options.scales.y.grid.color = currentThemeColors.gridColor;
                speedtestChart.options.scales.x.grid.color = currentThemeColors.gridColor;
                speedtestChart.options.plugins.legend.labels.color = currentThemeColors.textColor;
                speedtestChart.update();

                document.getElementById('speedtest-last-update').innerText = 'Last updated: ' + new Date().toLocaleTimeString();
            } catch (e) {
                console.error('Speedtest update failed', e);
                document.getElementById('speedtest-last-update').innerHTML = '<span style="color: #d93025;">Connection Error</span>';
            }
        }

        setInterval(fetchData, 5000);
        setInterval(fetchSpeedtestData, 10000); // Fetch speedtest data less frequently
        fetchData();
        fetchSpeedtestData();
    </script>
    <script>
        // Listen for changes in the prefers-color-scheme media query
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => {
            const newThemeColors = getThemeColors();
            // Update Ping Chart
            chart.data.datasets[0].borderColor = newThemeColors.borderColor;
            chart.data.datasets[0].backgroundColor = newThemeColors.backgroundColor;
            chart.options.scales.y.ticks.color = newThemeColors.textColor;
            chart.options.scales.x.ticks.color = newThemeColors.textColor;
            chart.options.scales.y.grid.color = newThemeColors.gridColor;
            chart.options.plugins.legend.labels.color = newThemeColors.textColor; // Update legend text color
            chart.update();

            // Update Speedtest Chart
            speedtestChart.data.datasets[0].borderColor = newThemeColors.borderColor; // Download
            speedtestChart.data.datasets[0].backgroundColor = newThemeColors.backgroundColor;
            // Upload color remains green, but background might change
            speedtestChart.data.datasets[1].backgroundColor = newThemeColors.isDarkMode ? 'rgba(40, 167, 69, 0.2)' : 'rgba(40, 167, 69, 0.1)';
            speedtestChart.options.scales.y.ticks.color = newThemeColors.textColor;
            speedtestChart.options.scales.x.ticks.color = newThemeColors.textColor;
            speedtestChart.options.scales.y.grid.color = newThemeColors.gridColor;
            speedtestChart.options.scales.x.grid.color = newThemeColors.gridColor;
            speedtestChart.options.plugins.legend.labels.color = newThemeColors.textColor;
            speedtestChart.update();
        });
    </script>
</body>
</html>`;

// HTTP Server with Routing
const server = http.createServer((req, res) => {
  // API Endpoint: Trigger speed test
  if (req.url.includes('/speedtest/run') && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    runSpeedTest().then(result => {
      res.end(JSON.stringify(result));
    });
    return;
  }

  // API Endpoint: Fetch speed test data
  if (req.url.includes('/speedtest/data')) {
    const urlParams = new URL(req.url, `http://${req.headers.host}`);
    const limit = parseInt(urlParams.searchParams.get('limit')) || 5;
    db.all("SELECT timestamp as t, download, upload, ping FROM speedtests ORDER BY timestamp DESC LIMIT ?", [limit], (err, rows) => {
      if (err) return res.end(JSON.stringify([]));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows.reverse()));
    });
    return;
  }

  // Handle /data and Ingress-proxied /data paths (Ping data)
  // This is placed last because it is the least specific route
  if (req.url.includes('/data')) {
    const urlParams = new URL(req.url, `http://${req.headers.host}`);
    const limit = parseInt(urlParams.searchParams.get('limit')) || 20;
    
    db.all("SELECT timestamp as t, value as v FROM pings ORDER BY timestamp DESC LIMIT ?", [limit], (err, rows) => {
      if (err) return res.end(JSON.stringify([]));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows.reverse()));
    });
    return;
  }

  // Root: Serve the HTML GUI
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(getHtmlGui());
});

server.listen(PORT, () => {
  console.log(`GUI available at http://localhost:${PORT}`); // This will be logged by HA
});
