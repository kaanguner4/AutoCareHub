'use strict';
// Small helpers for validation and fixed, client-safe error responses.

class HttpError extends Error {
  constructor(status, publicMessage) {
    super(publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

const badRequest = (msg) => new HttpError(400, msg);
const notFound = () => new HttpError(404, 'Not found.');
const conflict = (msg) => new HttpError(409, msg);

function text(value, { min = 0, max = 200 } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v.length >= min && v.length <= max ? v : null;
}

function id(value) {
  const s = String(value ?? '');
  return /^[1-9][0-9]{0,15}$/.test(s) ? s : null;
}

function int(value, { min, max }) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

module.exports = { HttpError, badRequest, notFound, conflict, text, id, int };
