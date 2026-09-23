import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhone } from "../src/services/mpesa.js";
test("normalizes Kenyan phone numbers",()=>{assert.equal(normalizePhone("0712345678"),"254712345678");assert.equal(normalizePhone("+254712345678"),"254712345678");assert.throws(()=>normalizePhone("0112345678"));});
