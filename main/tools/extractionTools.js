'use strict'
const fs   = require('fs')
const path = require('path')
const os   = require('os')
const registry = require('./registry')

const tm = () => require('../tabManager')

function tableToMarkdown({ rows }) {
  if (!rows || !rows.length) return ''
  const maxCols = Math.max(...rows.map(r => r.length))
  const padded = rows.map(r => {
    const p = [...r]
    while (p.length < maxCols) p.push('')
    return p.map(c => String(c).replace(/[\n\r]+/g, ' ').replace(/\|/g, '│').trim())
  })
  const header = '| ' + padded[0].join(' | ') + ' |'
  const sep    = '| ' + padded[0].map(() => '---').join(' | ') + ' |'
  const body   = padded.slice(1).map(r => '| ' + r.join(' | ') + ' |')
  return [header, sep, ...body].join('\n')
}

// ── extractTable ─────────────────────────────────────────────────────────────

registry.register({
  name: 'extractTable',
  description: 'Extract HTML tables from the current page as markdown. Returns all tables found (up to 5).',
  input_schema: {
    type: 'object',
    properties: {
      tableIndex: {
        type: 'number',
        description: 'Index of specific table to extract (0-based). Omit to get all.',
      },
    },
    required: [],
  },
  async execute({ tableIndex } = {}) {
    const tab = tm().getActiveTab()
    if (!tab || tab.type !== 'browser') return 'No browser tab active.'
    try {
      const raw = await tab.view.webContents.executeJavaScript(`
        (function() {
          var tables = document.querySelectorAll('table');
          return Array.from(tables).slice(0, 8).map(function(t) {
            var rows = [];
            t.querySelectorAll('tr').forEach(function(tr) {
              var cells = tr.querySelectorAll('th, td');
              if (cells.length) rows.push(Array.from(cells).map(function(c) { return c.innerText.trim(); }));
            });
            return {
              caption: t.caption ? t.caption.innerText.trim() : '',
              totalRows: t.querySelectorAll('tr').length,
              rows: rows,
            };
          });
        })()
      `)

      if (!raw.length) return 'No tables found on this page.'

      const targets = typeof tableIndex === 'number' ? [raw[tableIndex]].filter(Boolean) : raw.slice(0, 5)
      if (!targets.length) return `No table at index ${tableIndex}.`

      const parts = targets.map((t, i) => {
        const idx = typeof tableIndex === 'number' ? tableIndex : i
        const md = tableToMarkdown(t)
        const caption = t.caption ? ` — ${t.caption}` : ''
        return `### Table ${idx + 1}${caption} (${t.totalRows} rows)\n\n${md || '(empty table)'}`
      })

      return `Found ${raw.length} table(s).\n\n${parts.join('\n\n')}`
    } catch (e) {
      return `Error extracting tables: ${e.message}`
    }
  },
})

// ── exportCSV ────────────────────────────────────────────────────────────────

registry.register({
  name: 'exportCSV',
  description: 'Convert a markdown table to CSV and save to Desktop. Returns file path.',
  input_schema: {
    type: 'object',
    properties: {
      markdown: { type: 'string', description: 'Markdown table to convert' },
      filename: { type: 'string', description: 'Output filename without extension. Defaults to "export".' },
    },
    required: ['markdown'],
  },
  async execute({ markdown, filename = 'export' } = {}) {
    try {
      const lines = markdown.trim().split('\n')
        .filter(l => l.trim() && !/^\|[-:\s|]+\|$/.test(l.trim()))

      const csv = lines.map(line => {
        const cells = line.split('|').slice(1, -1).map(c => {
          const v = c.trim()
          return (v.includes(',') || v.includes('"') || v.includes('\n'))
            ? `"${v.replace(/"/g, '""')}"`
            : v
        })
        return cells.join(',')
      }).join('\n')

      const safeName = (filename || 'export').replace(/[^a-z0-9_\-]/gi, '_').slice(0, 50)
      const stamp = new Date().toISOString().slice(0, 10)
      const outPath = path.join(os.homedir(), 'Desktop', `${safeName}_${stamp}.csv`)
      fs.writeFileSync(outPath, csv, 'utf8')
      return `Saved CSV to: ${outPath}`
    } catch (e) {
      return `Error exporting CSV: ${e.message}`
    }
  },
})

// ── extractEntities ──────────────────────────────────────────────────────────

registry.register({
  name: 'extractEntities',
  description: 'Extract structured entities (prices, emails, phones, dates, URLs) from the current page.',
  input_schema: {
    type: 'object',
    properties: {
      types: {
        type: 'array',
        items: { type: 'string', enum: ['emails', 'phones', 'prices', 'urls', 'dates'] },
        description: 'Types to extract. Defaults to all.',
      },
    },
    required: [],
  },
  async execute({ types } = {}) {
    const tab = tm().getActiveTab()
    if (!tab || tab.type !== 'browser') return 'No browser tab active.'
    try {
      const raw = await tab.view.webContents.executeJavaScript(`
        (function() {
          var text  = document.body ? document.body.innerText : '';
          var hrefs = Array.from(document.querySelectorAll('a[href^="http"]')).map(function(a){ return a.href; }).slice(0,50);
          var emails = text.match(/[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}/g) || [];
          var phones = text.match(/(?:\\+?1[\\s\\-]?)?(?:\\(?\\d{3}\\)?[\\s.\\-]?)\\d{3}[\\s.\\-]?\\d{4}/g) || [];
          var prices = text.match(/\\$[\\d,]+(?:\\.\\d{2})?|[\\d,]+(?:\\.\\d{2})?\\s*(?:USD|EUR|GBP)/g) || [];
          var dates  = text.match(/\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|\\d{4}-\\d{2}-\\d{2}\\b/g) || [];
          function dedup(arr){ return arr.filter(function(v,i,a){ return a.indexOf(v)===i; }); }
          return {
            emails: dedup(emails).slice(0,30),
            phones: dedup(phones).slice(0,30),
            prices: dedup(prices).slice(0,30),
            urls:   dedup(hrefs).slice(0,30),
            dates:  dedup(dates).slice(0,30),
          };
        })()
      `)

      const want = types || ['emails', 'phones', 'prices', 'dates']
      const parts = []
      if (want.includes('emails') && raw.emails.length) parts.push(`**Emails (${raw.emails.length}):**\n${raw.emails.join(', ')}`)
      if (want.includes('phones') && raw.phones.length) parts.push(`**Phone Numbers (${raw.phones.length}):**\n${raw.phones.join(', ')}`)
      if (want.includes('prices') && raw.prices.length) parts.push(`**Prices (${raw.prices.length}):**\n${raw.prices.join(', ')}`)
      if (want.includes('urls')   && raw.urls.length)   parts.push(`**URLs (${raw.urls.length}):**\n${raw.urls.join('\n')}`)
      if (want.includes('dates')  && raw.dates.length)  parts.push(`**Dates (${raw.dates.length}):**\n${raw.dates.join(', ')}`)

      return parts.length ? parts.join('\n\n') : 'No entities of the requested types found.'
    } catch (e) {
      return `Error extracting entities: ${e.message}`
    }
  },
})

// ── getSelectedText ──────────────────────────────────────────────────────────

registry.register({
  name: 'getSelectedText',
  description: 'Get the text currently selected by the user on the page.',
  input_schema: { type: 'object', properties: {}, required: [] },
  async execute() {
    const tab = tm().getActiveTab()
    if (!tab || tab.type !== 'browser') return 'No browser tab active.'
    try {
      const text = await tab.view.webContents.executeJavaScript(`window.getSelection().toString()`)
      return text?.trim() || 'No text currently selected on the page.'
    } catch (e) {
      return `Error: ${e.message}`
    }
  },
})
