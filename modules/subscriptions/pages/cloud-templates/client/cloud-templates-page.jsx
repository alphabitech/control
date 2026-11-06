'use strict';

import { useEffect, useState } from 'react';
import { PageLayout } from '@loopar/page';
import { Button } from '@cn/components/ui/button';
import { Check, ExternalLink, LayoutTemplate } from 'lucide-react';

/**
 * Templates page (`/templates`): cards from the published `Site Template`
 * records (GET /api/signup/templates). "Use this template" goes to pricing
 * with `?template=<app>` so checkout can carry it as metadata.
 */

function TemplateCard({ template }) {
  const { name, title, sector, summary, features, demo_url: demoUrl, cover } = template;
  return (
    <article className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-shadow hover:shadow-md">
      <div className="relative aspect-[16/10] overflow-hidden bg-muted">
        {cover ? (
          <img
            src={cover}
            alt={`${title} template preview`}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <LayoutTemplate className="h-10 w-10" />
          </div>
        )}
        {sector && (
          <span className="absolute left-3 top-3 rounded-full bg-background/90 px-3 py-1 text-xs font-medium backdrop-blur">
            {sector}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-5 md:p-6">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {summary && <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{summary}</p>}

        {features?.length > 0 && (
          <ul className="mt-4 space-y-2 text-sm">
            {features.map((f) => (
              <li key={f} className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-auto flex flex-wrap gap-2 pt-6">
          {demoUrl && (
            <Button asChild variant="secondary" className="flex-1">
              <a href={demoUrl} target="_blank" rel="noopener noreferrer">
                Live demo <ExternalLink className="ml-1.5 h-4 w-4" />
              </a>
            </Button>
          )}
          <Button asChild className="flex-1">
            <a href={`/pricing?template=${encodeURIComponent(name)}`}>Use this template</a>
          </Button>
        </div>
      </div>
    </article>
  );
}

function Templates() {
  const [templates, setTemplates] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/signup/templates')
      .then((r) => r.json())
      .then((data) => { if (alive) setTemplates(Array.isArray(data?.templates) ? data.templates : []); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);

  if (error) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Templates could not be loaded right now. Please try again in a moment.</p>;
  }
  if (!templates) {
    return (
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => <div key={i} className="h-[30rem] animate-pulse rounded-2xl border border-border bg-muted/40" />)}
      </div>
    );
  }
  if (!templates.length) {
    return <p className="py-10 text-center text-sm text-muted-foreground">New templates are on the way.</p>;
  }

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {templates.map((t) => <TemplateCard key={t.name} template={t} />)}
    </div>
  );
}

const SLOTS = { templates: () => <Templates /> };

export default function CloudTemplatesPage() {
  return <PageLayout slots={SLOTS} />;
}
