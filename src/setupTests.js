// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// React Router uses the Encoding API, which is absent from Jest's jsdom.
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// jsdom has no Blob URL lifecycle; component tests can spy on these stubs.
if (!URL.createObjectURL) {
  let nextBlobUrl = 0;
  URL.createObjectURL = () => `blob:test-preview-${++nextBlobUrl}`;
  URL.revokeObjectURL = () => {};
}

// jsdom не реализует dialog. Его модальность и клавиатуру проверяем в Chrome.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
}
