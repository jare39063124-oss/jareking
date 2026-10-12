import type { JarekingApi } from './index';

declare global {
  interface Window {
    jareking: JarekingApi;
  }
}

export {};
