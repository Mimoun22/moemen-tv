// Vercel serverless entry: re-exports the Express app (no app.listen here).
const app = require('../server.js');

module.exports = app;
