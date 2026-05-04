'use strict'

function switchPanel(name) {
  document.querySelectorAll('.dash-panel').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.ds-item').forEach(i => i.classList.remove('active'))
  const panel = document.getElementById('panel-' + name)
  if (panel) panel.classList.add('active')
  const item = document.querySelector('[data-panel="' + name + '"]')
  if (item) item.classList.add('active')
}

document.querySelectorAll('.ds-item[data-panel]').forEach(item => {
  item.addEventListener('click', e => { e.preventDefault(); switchPanel(item.dataset.panel) })
})

function filterMemory(query) {
  const q = query.toLowerCase()
  document.querySelectorAll('.mem-item').forEach(item => {
    item.style.display = item.textContent.toLowerCase().includes(q) ? '' : 'none'
  })
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
