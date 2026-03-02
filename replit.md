# Template Express App

## Overview
A simple Express.js web server that serves static HTML pages with a basic REST API.

## Architecture
- **Runtime**: Node.js 18+ (ES Modules)
- **Framework**: Express 4.x
- **Port**: 5000 (bound to 0.0.0.0)

## Project Structure
```
index.js          - Main Express app entry point
routes/
  routes.js       - Dynamic page router (reads from routes.json)
  routes.json     - Maps URL paths to HTML files
  api.js          - REST API routes (/api/*)
public/
  pages/
    home/         - Home page (served at /)
    404/          - 404 error page
```

## Running the App
```bash
npm install
node index.js
```

## API Endpoints
- `GET /api/` - Welcome message
- `GET /api/status` - Server uptime and status

## Adding Pages
1. Add HTML file under `public/pages/<name>/index.html`
2. Add route mapping in `routes/routes.json`: `"/path": "pages/<name>/index.html"`

## Deployment
Configured for autoscale deployment. Run command: `node index.js`
