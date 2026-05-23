const { exec } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

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

// Use /data/ for persistent storage in Home Assistant add-ons
const LOG_FILE = '/data/network_tests.log';
// Ensure the file exists so the first read doesn't fail
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');

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
      const errorLine = `[${timestamp}] Error pinging ${TARGET}: ${error.message}. Stderr: ${stderr.trim()}\n`;
      fs.appendFileSync(LOG_FILE, errorLine);
      console.error(errorLine.trim());
      return;
    }
    if (EXTENSIVE_LOGGING)
    {
      console.log(`Ping`);
      console.log(stdout);
    }
  


    // Parsing the summary line for the average RTT
    // BusyBox (Alpine): round-trip min/avg/max = 14.501/16.234/19.112 ms
    // iputils (Debian): rtt min/avg/max/mdev = 14.501/16.234/19.112/1.456 ms
    const avgMatch = stdout.match(/=\s+[\d.]+\/([\d.]+)/);
    
    if (avgMatch && avgMatch[1] && !isNaN(parseFloat(avgMatch[1]))) {
      const avgPing = avgMatch[1];
      const rawInfo = EXTENSIVE_LOGGING ? ` | Raw: ${stdout.replace(/\n/g, " ").trim()}` : '';
      const logEntry = `[${timestamp}] Target: ${TARGET}, Avg Ping: ${avgPing} ms${rawInfo}\n`;
      
      fs.appendFileSync(LOG_FILE, logEntry);
      console.log(logEntry.trim());
    } else {
      const rawOutput = EXTENSIVE_LOGGING ? `. Raw Output: ${stdout.replace(/\n/g, " ").trim()}` : '';
      const warnMsg = `[${timestamp}] Ping succeeded but summary stats could not be parsed${rawOutput}\n`;
      fs.appendFileSync(LOG_FILE, warnMsg);
      console.warn(warnMsg.trim());
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
        body { font-family: -apple-system, sans-serif; background: #f0f2f5; padding: 20px; }
        .card { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); max-width: 1000px; margin: auto; }
        h1 { color: #1a73e8; margin-top: 0; }
        #chart-wrapper { height: 400px; margin-top: 20px; }
        .stats { color: #5f6368; font-size: 0.9em; text-align: right; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Network Latency: ${TARGET}</h1>
        <div class="stats" id="last-update">Waiting for data...</div>
        <div id="chart-wrapper"><canvas id="pingChart"></canvas></div>
    </div>
    <script>
        const ctx = document.getElementById('pingChart').getContext('2d');
        const chart = new Chart(ctx, {
            type: 'line',
            data: { labels: [], datasets: [{
                label: 'Avg Ping (ms)',
                data: [],
                borderColor: '#1a73e8',
                backgroundColor: 'rgba(26, 115, 232, 0.1)',
                fill: true,
                tension: 0.3
            }]},
            options: { 
                responsive: true, 
                maintainAspectRatio: false,
                scales: { y: { beginAtZero: false, min: undefined, max: undefined } }
            }
        });

        async function fetchData() {
            try {
                const res = await fetch('data');
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
                document.getElementById('last-update').innerText = 'Last updated: ' + new Date().toLocaleTimeString();
            } catch (e) { console.error('Update failed', e); }
        }

        setInterval(fetchData, 5000);
        fetchData();
    </script>
</body>
</html>`;

// HTTP Server with Routing
const server = http.createServer((req, res) => {
  // Handle /data and Ingress-proxied /data paths
  if (req.url.endsWith('/data')) {
    // API Endpoint: Parse the log file and return JSON
    console.log('API Request: Fetching log data...');
    if (!fs.existsSync(LOG_FILE)) return res.end(JSON.stringify([]));
    
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    const data = raw.trim().split('\n').map(line => {
      const match = line.match(/\[(.*?)\] .*? Avg Ping: (.*?) ms/);
      return match ? { t: match[1], v: parseFloat(match[2]) } : null;
    }).filter(Boolean);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data.slice(-20))); // Return last 20 points
  }

  // Root: Serve the HTML GUI
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(getHtmlGui());
});

server.listen(PORT, () => {
  console.log(`GUI available at http://localhost:${PORT}`); // This will be logged by HA
});
