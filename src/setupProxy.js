// CRA loads this file only in its Node development server, never in the browser.
const express = require('express');
const photos = require('../server/photos.cjs');

module.exports = function setupProxy(app) {
  app.all('/api/photos',
    express.text({ type: 'application/json', limit: '32kb' }),
    photos.createHandler(),
    (error, req, res, next) => {
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(error.status || 400).json({
        error: error.status === 413 ? 'Слишком большой запрос.' : 'Некорректный запрос.',
      });
    });
};
