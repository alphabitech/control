'use strict';

/*
 * Small client helpers shared by the mail forms and lists.
 */

import { useEffect, useRef, useState } from 'react';
import loopar from 'loopar';
import { useActions, useDocument } from '@loopar/document';
import { Button } from '@cn/components/ui/button';

/** Promise-based server call: resolves the payload, rejects (after the toast) on error. */
export function call(entity, action, { name, body, freeze = true } = {}) {
  return new Promise((resolve, reject) => {
    loopar.call(entity, action, {
      ...(name ? { query: { name } } : {}),
      ...(body ? { body } : {}),
      freeze,
      success: resolve,
      error: reject,
    });
  });
}

export const confirm = (message) => new Promise((resolve) => loopar.confirm(message, () => resolve(true)));

function DialogFields({ fields, values }) {
  const [state, setState] = useState(() => Object.fromEntries(fields.map((f) => [f.name, f.default ?? ''])));
  useEffect(() => { Object.assign(values, state); }, [state, values]);
  const cls = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
  return (
    <div className="space-y-3">
      {fields.map((f) => (
        <label key={f.name} className="block space-y-1">
          <span className="text-sm font-medium">{f.label}</span>
          <input
            className={cls}
            type={f.type || 'text'}
            autoComplete={f.type === 'password' ? 'new-password' : 'off'}
            value={state[f.name]}
            onChange={(e) => setState((s) => ({ ...s, [f.name]: e.target.value }))}
          />
          {f.help && <span className="block text-xs text-muted-foreground">{f.help}</span>}
        </label>
      ))}
    </div>
  );
}

/**
 * Asks for some values in a dialog. Resolves with { name: value } on OK.
 * fields: [{ name, label, type, default, help }]
 */
export function ask({ title, message, fields = [] }) {
  return new Promise((resolve) => {
    const values = Object.fromEntries(fields.map((f) => [f.name, f.default ?? '']));
    loopar.dialog({
      type: 'confirm',
      title,
      content: (
        <div className="space-y-3">
          {message && <p className="text-sm text-muted-foreground">{message}</p>}
          {fields.length > 0 && <DialogFields fields={fields} values={values} />}
        </div>
      ),
      ok: () => resolve({ ...values }),
    });
  });
}

/**
 * App-bar buttons for record actions.
 * actions: [{ key, label, when?(data), variant?, run(name, data) }]
 * A button shows only on a saved record and when `when` returns true.
 */
export function useRecordActions(actions) {
  const { Document = {} } = useDocument() || {};
  const ref = useRef(Document);
  ref.current = Document;

  const data = Document.data || {};
  const visible = Document.isNew ? [] : actions.filter((a) => !a.when || a.when(data));

  useActions(Object.fromEntries(visible.map((a) => [
    `mail_${a.key}`,
    <Button
      key={a.key}
      variant={a.variant || 'secondary'}
      onClick={async (e) => {
        e.preventDefault();
        const D = ref.current;
        try {
          await a.run(D.name || D.data?.name, D.data || {});
        } catch (err) {
          if (err && !err.notify && err.message) console.warn('[mail]', err.message);
        }
      }}
    >
      {a.label}
    </Button>,
  ])));

  return { Document, data };
}
