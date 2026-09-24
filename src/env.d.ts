/// <reference types="vite/client" />
import type { CrewdeckApi } from '../shared/ipc';

declare global {
  interface Window {
    crewdeck: CrewdeckApi;
  }
}

export {};
