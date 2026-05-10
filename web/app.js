'use strict'

function switchPanel(name) {
  document.querySelectorAll('.dash-panel').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.ds-item').forEach(i => i.classList.remove('active'))
  const panel = document.getElementById('panel-' + name)
  if (panel) panel.classList.add('active')
  const item = document.querySelector('.ds-item[data-panel="' + name + '"]')
  if (item) item.classList.add('active')
}

document.querySelectorAll('[data-panel]').forEach(el => {
  el.addEventListener('click', e => { e.preventDefault(); switchPanel(el.dataset.panel) })
})

function filterMemory(query) {
  const q = query.toLowerCase()
  document.querySelectorAll('.mem-item').forEach(item => {
    item.style.display = item.textContent.toLowerCase().includes(q) ? '' : 'none'
  })
}

const memSearch = document.getElementById('memory-search')
if (memSearch) {
  memSearch.addEventListener('input', () => filterMemory(memSearch.value))
}

document.querySelectorAll('.vault-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const orig = btn.textContent
    btn.textContent = 'Copied!'
    btn.style.color = 'var(--green)'
    setTimeout(() => { btn.textContent = orig; btn.style.color = '' }, 1200)
  })
})

document.querySelectorAll('.routine-run:not(:disabled)').forEach(btn => {
  btn.addEventListener('click', () => {
    const orig = btn.textContent
    btn.textContent = '⟳ Running…'
    btn.disabled = true
    setTimeout(() => {
      btn.textContent = '✓ Done'
      btn.style.color = 'var(--green)'
      setTimeout(() => { btn.textContent = orig; btn.style.color = ''; btn.disabled = false }, 1500)
    }, 1800)
  })
})

document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'))
    if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  })
})

const dashMeta = document.getElementById('dash-meta')
if (dashMeta) {
  const now = new Date()
  const day = now.toLocaleDateString('en-US', { weekday: 'long' })
  const date = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
  dashMeta.textContent = day + ' · ' + date + ' · Everything is running smoothly'
}
