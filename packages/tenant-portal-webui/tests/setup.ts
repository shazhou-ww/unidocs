import "@testing-library/jest-dom/vitest";

// jsdom 不实现 Selection.getRangeAt 之外的部分行为，Task 9 的选区测试按需补。
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }) as MediaQueryList;
}
