// Juniper & Rye: the little bit of script the site needs.

// Phones: the menu button opens and closes the navigation.
const toggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('.nav');
if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
}

// "Add" buttons put an item in the order and update the counter.
let count = 0;
const cart = document.querySelector('.cart');
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-add]');
  if (!button) return;
  count += 1;
  cart.textContent = `Order · ${count} item${count === 1 ? '' : 's'}`;
});

// The newsletter form sends the address to the mailing-list service.
const form = document.querySelector('.newsletter');
if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = form.querySelector('input[name=email]').value;
    await fetch('/api/subscribe', { method: 'POST', body: JSON.stringify({ email }) }).catch(() => {});
    document.querySelector('.thanks').textContent = `Thanks! We'll write to ${email} once a month.`;
  });
}
