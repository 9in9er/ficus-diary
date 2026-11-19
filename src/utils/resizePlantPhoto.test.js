import { resizePlantPhoto } from './resizePlantPhoto';

const OriginalImage = global.Image;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let canvas;
let sourceWidth;
let sourceHeight;
beforeEach(() => {
  sourceWidth = 3000; sourceHeight = 2000;
  URL.createObjectURL = jest.fn(() => 'blob:preview');
  URL.revokeObjectURL = jest.fn();
  global.Image = class {
    constructor() { this.naturalWidth = sourceWidth; this.naturalHeight = sourceHeight; }
    set src(value) { this.onload(); }
  };
  canvas = { getContext: () => ({ drawImage: jest.fn() }), toBlob: jest.fn((cb) => cb(new Blob(['webp'], { type: 'image/webp' }))) };
  const originalCreateElement = document.createElement.bind(document);
  jest.spyOn(document, 'createElement').mockImplementation((name, ...args) => name === 'canvas' ? canvas : originalCreateElement(name, ...args));
});
afterEach(() => {
  global.Image = OriginalImage;
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  jest.restoreAllMocks();
});

test.each([[3000, 2000, 1600, 1067], [1200, 3000, 640, 1600], [200, 400, 200, 400]])('optimizes %sx%s without enlarging, WebP quality 0.8', async (w, h, expectedW, expectedH) => {
  sourceWidth = w; sourceHeight = h;
  const result = await resizePlantPhoto(new File(['original'], 'plant.jpg', { type: 'image/jpeg' }));
  expect(result.type).toBe('image/webp');
  expect(canvas.width).toBe(expectedW);
  expect(canvas.height).toBe(expectedH);
  expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/webp', 0.8);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
});

test('rejects invalid input and browsers that cannot output WebP', async () => {
  await expect(resizePlantPhoto(new File(['text'], 'bad.txt', { type: 'text/plain' }))).rejects.toThrow();
  canvas.toBlob.mockImplementation((cb) => cb(new Blob(['png'], { type: 'image/png' })));
  await expect(resizePlantPhoto(new File(['image'], 'plant.jpg', { type: 'image/jpeg' }))).rejects.toThrow();
});
