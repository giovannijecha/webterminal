import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Run an owned module with its external edges replaced by fixture APIs.
export function moduleUnderTest(name, bindings, exports) {
  const source = readFileSync(new URL(`../../assets/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^export /gm, '');
  const context = vm.createContext({TextDecoder, Uint8Array, atob, setTimeout, clearTimeout, ...bindings});
  vm.runInContext(`${source}\nglobalThis.probed = {${exports.join(',')}};`, context, {filename:name});
  return context.probed;
}
