import { DEFAULT_CONFIG } from "../shared/defaults.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class DesktopStore {
  async bootstrap() {
    const payload = await window.meetingDesktop.getBootstrap();
    return {
      ...payload,
      config: { ...clone(DEFAULT_CONFIG), ...(payload?.config || {}) },
    };
  }

  async saveConfig(config) {
    return window.meetingDesktop.saveConfig(config);
  }
}
