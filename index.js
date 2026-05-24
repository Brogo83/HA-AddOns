const { exec } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
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

// Database Setup
const DB_PATH = '/data/network_tester.db';
const db = new sqlite3.Database(DB_PATH);

// Initialize Database
db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS pings (timestamp TEXT, value REAL)");
});

// Ensure PORT is a valid number and handle potential NaN from env variables or malformed options
const rawPort = options.port || process.env.HA_PORT || '8099'; // Get the raw port value
console.log(`DEBUG: rawPort = '${rawPort}' (type: ${typeof rawPort})`);
const parsedPort = parseInt(rawPort, 10); // Attempt to parse it
console.log(`DEBUG: parsedPort = ${parsedPort} (type: ${typeof parsedPort})`);
const PORT = isNaN(parsedPort) ? 8099 : parsedPort; // Use default if parsing failed
console.log(`DEBUG: Final PORT = ${PORT} (type: ${typeof PORT})`);

/**
 * Executes the ping test, parses the output for average RTT, 
 * and appends the result to the log file.
 */
function runNetworkTest() {
  const timestamp = new Date().toISOString();
  
  // Executing 'ping -c 4' for Unix-based systems
  exec(`ping -c ${PING_COUNT} ${TARGET}`, (error, stdout, stderr) => {
    if (error) {
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
        db.run("DELETE FROM pings WHERE timestamp NOT IN (SELECT timestamp FROM pings ORDER BY timestamp DESC LIMIT 1000)");
      });

      console.log(`[${timestamp}] Target: ${TARGET}, Avg Ping: ${avgPing} ms`);
    } else {
      if (EXTENSIVE_LOGGING) console.warn(`[${timestamp}] Ping succeeded but summary stats could not be parsed.`);
    }
  });
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
        .controls { display: flex; align-items: center; gap: 10px; color: #5f6368; font-size: 0.9em; }
        select { 
            padding: 5px; 
            border-radius: 4px; 
            border: 1px solid #ccc; 
            background-color: white; 
            color: #333; 
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
                <div id="last-update">...</div>
            </div>
        </div>
        <div id="chart-wrapper"><canvas id="pingChart"></canvas></div>
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

                chart.update('none');
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

                document.getElementById('last-update').innerText = 'Last updated: ' + new Date().toLocaleTimeString();
            } catch (e) { console.error('Update failed', e); }
        }

        setInterval(fetchData, 5000);
        fetchData();
    </script>
    <script>
        // Listen for changes in the prefers-color-scheme media query
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => {
            const newThemeColors = getThemeColors();
            chart.data.datasets[0].borderColor = newThemeColors.borderColor;
            chart.data.datasets[0].backgroundColor = newThemeColors.backgroundColor;
            chart.options.scales.y.ticks.color = newThemeColors.textColor;
            chart.options.scales.x.ticks.color = newThemeColors.textColor;
            chart.options.scales.y.grid.color = newThemeColors.gridColor;
            chart.options.scales.x.grid.color = newThemeColors.gridColor;
            chart.options.plugins.legend.labels.color = newThemeColors.textColor;
            chart.options.plugins.legend.labels.color = newThemeColors.textColor; // Update legend text color
            chart.update();
        });
    </script>
</body>
</html>`;

// HTTP Server with Routing
const server = http.createServer((req, res) => {
  // Handle /data and Ingress-proxied /data paths
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
