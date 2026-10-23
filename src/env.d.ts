/// <reference types="vite/client" />
import type { ZapfleetApi } from '../shared/ipc';

declare global {
  interface Window {
    zapfleet: ZapfleetApi;
  }
}

export {};
