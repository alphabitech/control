'use strict';

import { useRef } from 'react';
import loopar from 'loopar';
import { FormLayout } from '@loopar/form';
import { useActions, useDocument } from '@loopar/document';
import { Button } from '@cn/components/ui/button';
import { Link2, Send } from 'lucide-react';

const portalAccess = (name, send) => new Promise((resolve, reject) => {
  loopar.call('Subscription', 'portalAccess', { query: { name, send: send ? 1 : 0 }, freeze: true, success: resolve, error: reject });
});

/**
 * Subscription (read-only: Stripe and the signup flows write it) — operator
 * actions for the customer portal: email an invitation, or get the sign-in
 * link to hand over or to see the portal as the customer.
 */
export default function SubscriptionView() {
  const { Document = {} } = useDocument() || {};
  const ref = useRef(Document);
  ref.current = Document;
  const nameOf = () => ref.current.name || ref.current.data?.name;
  const customer = Document.data?.customer;

  const sendInvitation = () => loopar.confirm(
    `Email ${customer} a sign-in link to the customer portal? Older links stop working.`,
    async () => {
      const r = await portalAccess(nameOf(), true);
      loopar.notify({ message: `Invitation sent to ${r?.email || customer}.`, type: 'success' });
    },
  );

  const getLink = async () => {
    const r = await portalAccess(nameOf(), false);
    loopar.dialog({
      type: 'alert',
      title: 'Customer portal link',
      content: (
        <div className="space-y-3 text-sm">
          <p>Signs in once as <b>{r?.user}</b> and expires in 7 days. Older links stop working.</p>
          <input readOnly value={r?.url || ''} onFocus={(e) => e.target.select()}
            className="w-full rounded-md border bg-muted px-2 py-1.5 font-mono text-xs" />
          <p className="text-muted-foreground">
            To see the portal as the customer, open it in a private window: in this one it would replace your session.
          </p>
        </div>
      ),
    });
  };

  useActions(Document.isNew || !customer ? {} : {
    portal_invite: <Button key="portal_invite" variant="secondary" onClick={(e) => { e.preventDefault(); sendInvitation(); }}><Send className="w-4 h-4 mr-1" />Email portal invitation</Button>,
    portal_link: <Button key="portal_link" variant="secondary" onClick={(e) => { e.preventDefault(); getLink().catch(() => {}); }}><Link2 className="w-4 h-4 mr-1" />Get portal link</Button>,
  });

  return <FormLayout />;
}
