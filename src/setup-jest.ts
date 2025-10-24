// src/setup-jest.ts
import "whatwg-fetch";

// Mock fetch for tests
global.fetch = jest.fn();
performance.now = () => Date.now();