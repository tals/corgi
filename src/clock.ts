import {testBuild} from "./build_assets";
let offset_ms = 0;
export function milliTimestamp(): number { return Date.now() + offset_ms; }
export function microTimestamp(): number { return milliTimestamp() * 1000; }
export function advance(ms: number): void { if(testBuild)offset_ms += ms; }
export function reset(): void { offset_ms = 0; }
