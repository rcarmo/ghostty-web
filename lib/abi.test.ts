import { describe, expect, test } from 'bun:test';
import { AbiLayout, moduleAbi, readBits } from './abi';
import { Ghostty } from './ghostty';

const manifest = (types: object) =>
  JSON.stringify({ abi: { pointer_size: 4, usize_size: 4, endian: 'little' }, types });
describe('module ABI manifest', () => {
  test('resolves moved fields and packed flags instead of fixed offsets', () => {
    const abi = new AbiLayout(
      manifest({
        Style: { size: 32, fields: { flags: { offset: 24, size: 4, type: 'u32' } } },
        Flags: { size: 4, bits: { bold: { lsb: 19, width: 1 } } },
      })
    );
    expect(abi.size('Style')).toBe(32);
    expect(abi.offset('Style', 'flags')).toBe(24);
    expect(readBits(1 << 19, 0, abi.bits('Flags', 'bold'))).toBe(1);
  });
  test('rejects invalid widths, missing types and fields outside their allocation', () => {
    const abi = new AbiLayout(
      manifest({
        Bad: { size: 8, fields: { field: { offset: 7, size: 4 } } },
        Flags: { size: 2, bits: { bad: { lsb: 15, width: 4 } } },
      })
    );
    expect(() => abi.offset('Bad', 'field')).toThrow();
    expect(() => abi.expectFieldSize('Flags', 'bad', 4)).toThrow();
    expect(() => abi.size('missing')).toThrow();
    expect(() => abi.bits('Flags', 'bad')).toThrow();
    expect(
      () =>
        new AbiLayout(
          JSON.stringify({ abi: { pointer_size: 8, usize_size: 8, endian: 'little' }, types: {} })
        )
    ).toThrow();
  });
  test('validates selector constants and rejects unknown enum values', () => {
    const abi = new AbiLayout(manifest({ Option: { size: 4, values: { MODE: 37 } } }));
    expect(() => abi.validateEnum('Option', { MODE: 35 })).toThrow('Incompatible');
    expect(abi.enumValue('Option', 'MODE')).toBe(37);
  });
  test('caches once per loaded module and fails closed on a malformed manifest', async () => {
    const ghostty = await Ghostty.load();
    const exports = (ghostty as any).exports;
    expect(moduleAbi(exports)).toBe(moduleAbi(exports));
    expect(moduleAbi(exports).size('GhosttyStyle')).toBeGreaterThan(0);
    const memory = new WebAssembly.Memory({ initial: 1 });
    expect(() =>
      moduleAbi({ memory, ghostty_type_json: () => memory.buffer.byteLength } as any)
    ).toThrow('pointer');
  });
});
