import { test } from "node:test";
import assert from "node:assert/strict";
import "loopar";
import { splitAddress, mailboxValues, aliasValues } from "../modules/mail-hosting/mail-service.js";
import { matchRecords } from "../../../packages/loopar/core/document/base-document.js";

test("address: local part and domain, lowercased; anything else is not an address", () => {
  assert.deepEqual(splitAddress(" Ana@Client.com "), { localPart: "ana", domain: "client.com" });
  assert.equal(splitAddress("ana"), null);
  assert.equal(splitAddress("a@b@c"), null);
});

test("mailbox from Migadu: full form values, permissions default on", () => {
  const m = mailboxValues("client.com", { local_part: "Ana", name: "Ana R", may_send: false });
  assert.deepEqual(m, {
    name: "ana@client.com", address: "ana@client.com", domain: "client.com", local_part: "ana",
    display_name: "Ana R", recovery_email: "", status: "Active", may_send: 0, may_receive: 1, may_access_imap: 1, is_internal: 0,
  });
});

test("alias from Migadu: destinations one per line", () => {
  assert.equal(aliasValues("client.com", { local_part: "sales", destinations: ["ana@client.com", "luis@client.com"] }).destinations,
    "ana@client.com\nluis@client.com");
});

test("virtual records: equality filters compare as text", () => {
  const rows = [{ domain: "a.com", may_send: 1 }, { domain: "b.com", may_send: 0 }];
  assert.equal(matchRecords(rows, { may_send: "1" }).length, 1);
  assert.equal(matchRecords(rows, { domain: "b.com", may_send: 0 }).length, 1);
  assert.equal(matchRecords(rows, {}).length, 2);
});

test("mailbox status: inactive only when it can't send, receive or sign in", () => {
  const off = { local_part: "x", may_send: false, may_receive: false, may_access_imap: false };
  assert.equal(mailboxValues("client.com", off).status, "Inactive");
  assert.equal(mailboxValues("client.com", { ...off, may_receive: true }).status, "Active");
});
