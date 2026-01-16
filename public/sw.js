const CACHE_NAME = 'inventory-v1';
const ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/data/sales.csv',
    '/data/inventory.csv'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});
