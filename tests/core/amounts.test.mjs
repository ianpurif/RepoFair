import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAtomic,sumAtomic,assertPositiveAtomic} from '../../packages/core/src/amounts.ts';
test('atomic amounts use exact large integer arithmetic',()=>assert.equal(sumAtomic(['9007199254740993','7']),'9007199254741000'));
test('zero is a valid nonnegative accounting amount',()=>assert.equal(parseAtomic('0'),0n));
for(const invalid of ['-1','1.5','1e6','NaN',' 1','01','0x10','', '1'.repeat(79)]) {
 test(`reject atomic input ${JSON.stringify(invalid)}`,()=>assert.throws(()=>parseAtomic(invalid),{code:'INVALID_ATOMIC_AMOUNT'}));
}
test('a paid purchase cannot be zero',()=>assert.throws(()=>assertPositiveAtomic('0'),{code:'ZERO_PURCHASE'}));
