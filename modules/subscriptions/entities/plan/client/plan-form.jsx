'use strict';

import { useRef } from 'react';
import loopar from 'loopar';
import { FormLayout } from '@loopar/form';
import { useActions, useDocument } from '@loopar/document';
import { Button } from '@cn/components/ui/button';
import { Rocket } from 'lucide-react';

const publish = (name) => new Promise((resolve, reject) => {
  loopar.call('Plan', 'publish', { query: { name }, freeze: true, success: resolve, error: reject });
});

/** Plan form — a plan kept in Stripe's test mode can be published to live. */
export default function PlanForm() {
  const { Document = {} } = useDocument() || {};
  const ref = useRef(Document);
  ref.current = Document;
  const data = Document.data || {};
  const isTest = !Document.isNew && String(data.name || '').startsWith('test:');

  const toLive = () => loopar.confirm(
    `Publish "${data.plan_name}" to live? It is created in Stripe's live mode with this name, limits, features and price, and can be offered to customers. From then on the live plan is edited on its own.`,
    async () => {
      const D = ref.current;
      const r = await publish(D.name || D.data?.name);
      loopar.notify({ message: `${data.plan_name} is now live.`, type: 'success' });
      if (r?.published) loopar.navigate(`/desk/Plan/update?name=${encodeURIComponent(r.published)}`);
    },
  );

  useActions(isTest ? {
    plan_publish: <Button key="plan_publish" variant="secondary" onClick={(e) => { e.preventDefault(); toLive(); }}><Rocket className="w-4 h-4 mr-1" />Publish to live</Button>,
  } : {});

  return (
    <FormLayout>
      {isTest && (
        <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <b>Test mode.</b> This plan lives in Stripe's test mode: customers never see it. Publish it to live when it is ready.
        </div>
      )}
    </FormLayout>
  );
}
