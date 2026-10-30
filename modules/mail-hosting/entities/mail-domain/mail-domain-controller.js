'use strict';

import { BaseController } from 'loopar';
import {
  fail, now, targetDoc, configureDns, checkAndActivate, importDomainContent, importAll,
} from '../../mail-service.js';

export default class MailDomainController extends BaseController {
  static postOnlyActions = ['previewDns', 'configureDns', 'checkDomain', 'syncContent', 'importAll'];

  constructor(props) {
    super(props);
  }

  async #dns(dryRun) {
    const doc = await targetDoc(this);
    if (doc.dns_provider === 'Manual') fail('This domain uses manual DNS. Copy the records from Migadu into the DNS provider.');
    const res = await configureDns(doc.name, { dryRun });
    await doc.setSystem({ dns_report: res.report, cloudflare_zone: res.zone?.name || '', last_checked: now() });
    return res;
  }

  async actionPreviewDns() {
    const res = await this.#dns(true);
    const changes = res.ops.filter((o) => o.op !== 'keep').length;
    return await this.success(changes ? `${changes} change(s) needed — see the DNS report.` : 'DNS already has every record Migadu needs.', { refresh: 'soft' });
  }

  async actionConfigureDns() {
    const res = await this.#dns(false);
    const changes = res.ops.filter((o) => o.op !== 'keep' && !o.error).length;
    if (res.errors.length) {
      return await this.success(`${changes} change(s) applied, ${res.errors.length} failed — see the DNS report.`, { refresh: 'soft' });
    }
    return await this.success(
      changes ? `${changes} DNS change(s) applied. Run "Check & activate" in a few minutes.` : 'DNS already had every record. Run "Check & activate".',
      { refresh: 'soft' },
    );
  }

  async actionCheckDomain() {
    const doc = await targetDoc(this);
    const res = await checkAndActivate(doc.name);
    await doc.setSystem({
      status: res.status,
      activated_at: res.activatedAt || doc.activated_at || '',
      check_report: res.report,
      last_checked: now(),
    });
    return await this.success(res.message, { refresh: 'soft' });
  }

  async actionSyncContent() {
    const doc = await targetDoc(this);
    const c = await importDomainContent(doc.name);
    const parts = [
      `Mailboxes: ${c.mailboxes.created} new, ${c.mailboxes.updated} updated.`,
      `Aliases: ${c.aliases.created} new, ${c.aliases.updated} updated.`,
    ];
    if (c.localOnly.length) parts.push(`Only in Loopar (not in Migadu): ${c.localOnly.join(', ')}.`);
    if (c.failed.length) parts.push(`Could not import: ${c.failed.join('; ')}.`);
    return await this.success(parts.join(' '), { refresh: 'soft' });
  }

  async actionImportAll() {
    const summary = await importAll();
    return await this.success(summary.length ? `Imported: ${summary.join(' · ')}` : 'Migadu has no domains yet.', { refresh: 'soft' });
  }
}
