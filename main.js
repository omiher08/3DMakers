const SUPABASE_URL = 'https://eeibzzxbpofmgbeoqaze.supabase.co/rest/v1/';
const SUPABASE_KEY = 'sb_publishable_UwrrVvhsDhvrl7F7MPv-Sw_4XFnI2us';
// IMPORTANTE: las llaves nuevas de Supabase (sb_publishable_... / sb_secret_...)
// NO son JWT. Si se envían también en el header "Authorization: Bearer ...",
// Supabase intenta interpretarlas como un JWT y rechaza la petición.
// Deben enviarse ÚNICAMENTE en el header "apikey".
const SUPABASE_HEADERS = {
    'apikey': SUPABASE_KEY
};
const PRODUCTOS_TABLE = 'Productos';

// Constantes de Carrito y Caché
const CART_KEY = 'cartagena3d_cart';
const CART_EXPIRATION_HOURS = 2; // Actualizado a 2 horas
const CACHE_EXPIRATION_MINUTES = 30; // 30 minutos de caché local para Supabase

// Variables Globales
let baseDeDatosProductos = [];
let categoriaActual = 'todos';
let busquedaActual = '';
let cantidadActual = 1;
let productoActual = null;
let galeriaImagenes = [];   // Array de URLs de la galería del producto actual
let indiceImagenActual = 0; // Índice de la imagen activa en la galería

const PLACEHOLDER_IMG = 'https://placehold.co/800x800/121212/00e5ff?text=Sin+Foto';

const formatMoney = (amount) => {
    return new Intl.NumberFormat('es-CO').format(amount);
};

/* ====================================================
   OPTIMIZACIÓN DE TAMAÑO DE IMÁGENES (Supabase Storage)
   -----------------------------------------------------
   Las URLs actuales usan el endpoint "crudo" de Supabase
   Storage (/storage/v1/object/public/...). Ese endpoint
   IGNORA parámetros tipo ?w=800&q=80&auto=format (son de
   estilo Imgix/Unsplash): siempre entrega el archivo
   original, sin redimensionar ni comprimir.

   Supabase sí soporta redimensionar/comprimir "al vuelo"
   mediante su endpoint de Transformación de Imágenes
   (/storage/v1/render/image/public/...), disponible en
   proyectos con el add-on "Image Transformations" activo
   (plan Pro o superior). Si tu proyecto lo tiene activo,
   cambia la constante de abajo a `true`: todas las miniaturas
   del catálogo y destacados pedirán automáticamente una
   versión más liviana (menos peso = catálogo más rápido y
   menos consumo de datos), y la imagen del detalle pedirá
   una versión de mayor resolución.
   Si tu proyecto NO tiene el add-on, deja esto en `false`
   (valor por defecto): las imágenes seguirán funcionando
   exactamente igual que hoy, solo sin este ahorro extra.
==================================================== */
const HABILITAR_TRANSFORMACION_IMAGENES_SUPABASE = false;

function optimizarUrlImagenSupabase(url, anchoDeseado = 600) {
    if (!HABILITAR_TRANSFORMACION_IMAGENES_SUPABASE || !url) return url;
    if (!url.includes('/storage/v1/object/public/')) return url; // No es una URL de Supabase Storage

    const urlTransformada = url.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/');
    const separador = urlTransformada.includes('?') ? '&' : '?';
    return `${urlTransformada}${separador}width=${anchoDeseado}&quality=75&resize=contain`;
}

/* ====================================================
   PRECARGA INTELIGENTE EN TIEMPO OCIOSO (Idle)
   -----------------------------------------------------
   Objetivo: cuando el usuario está en la landing, aprovechar
   los ratos en que el navegador está "libre" (sin bloquear el
   renderizado ni competir con las imágenes que la landing sí
   necesita) para dejar precargadas, en segundo plano, las
   imágenes del catálogo que probablemente vera a continuación.

   - Usa requestIdleCallback (con fallback a setTimeout en
     navegadores que no lo soportan, ej. Safari).
   - Reparte la precarga en lotes pequeños (2 imágenes por turno
     ocioso) para no saturar la conexión ni competir con recursos
     críticos de la propia landing.
   - Respeta conexiones lentas / modo "Ahorro de datos": si el
     navegador lo reporta, no precarga nada.
   - Tiene un tope máximo de imágenes (MAX_IMAGENES_PRECARGA_IDLE)
     para no descargar "todo el catálogo" ni disparar el consumo
     de datos, solo lo que razonablemente se verá primero.
   - Usa <link rel="prefetch"> con fetchpriority="low": el propio
     navegador la trata como una pista de baja prioridad para la
     SIGUIENTE navegación, sin robarle ancho de banda a la página
     actual. El resultado queda en la caché HTTP normal, así que
     cuando productos.html pida esa misma URL, la sirve al instante.
==================================================== */
const MAX_IMAGENES_PRECARGA_IDLE = 10;
const IMAGENES_PRECARGADAS = new Set();

function programarTareaIdle(callback, timeout = 2000) {
    if ('requestIdleCallback' in window) {
        requestIdleCallback(callback, { timeout });
    } else {
        setTimeout(callback, 300); // Fallback simple para navegadores sin soporte
    }
}

function conexionPermitePrecarga() {
    const conexion = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conexion) return true; // Sin info de conexión disponible: asumimos que está bien
    if (conexion.saveData) return false; // El usuario activó "Ahorro de datos"
    if (conexion.effectiveType && ['slow-2g', '2g'].includes(conexion.effectiveType)) return false;
    return true;
}

function precargarImagenIdle(url) {
    if (!url || IMAGENES_PRECARGADAS.has(url)) return;
    IMAGENES_PRECARGADAS.add(url);

    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.as = 'image';
    link.href = url;
    try { link.fetchPriority = 'low'; } catch (e) { /* navegadores sin soporte lo ignoran */ }
    document.head.appendChild(link);
}

// Se llama desde la landing (index.html) una vez que ya tenemos el listado
// de productos. Precarga en segundo plano las imágenes del catálogo que
// NO son destacadas (esas ya se descargaron al mostrar el carrusel).
function precargarImagenesCatalogoEnIdle() {
    if (!conexionPermitePrecarga()) return;
    if (!baseDeDatosProductos || baseDeDatosProductos.length === 0) return;

    const candidatas = baseDeDatosProductos
        .filter(p => !p.destacado)
        .slice(0, MAX_IMAGENES_PRECARGA_IDLE)
        .map(p => optimizarUrlImagenSupabase(p.imagen, 500)); // mismo ancho que usará la tarjeta del catálogo

    let indice = 0;
    function precargarSiguienteLote() {
        candidatas.slice(indice, indice + 2).forEach(precargarImagenIdle);
        indice += 2;
        if (indice < candidatas.length) {
            programarTareaIdle(precargarSiguienteLote);
        }
    }

    programarTareaIdle(precargarSiguienteLote);
}

document.addEventListener('DOMContentLoaded', () => {
    console.log("🚀 Sistema de Cartagena 3D Makers Inicializado");
    
    initCart(); // Inicializar y validar persistencia del carrito

    if (document.getElementById('featured-products-container')) initIndexPage();
    if (document.getElementById('products-grid')) initCatalogPage();
    if (document.getElementById('product-container')) initProductPage();
    if (document.getElementById('cart-items-container')) initCartPage();
});

/* ====================================================
   SISTEMA DE CACHÉ PARA SUPABASE (Optimización)
   - Recibe la URL completa ya construida (con los campos
     y filtros necesarios) para minimizar el payload.
   - Reutiliza caché local por 30 minutos, igual que antes.
==================================================== */
async function fetchFromSupabaseWithCache(cacheKeySuffix, url) {
    const cacheKey = `cartagena3d_cache_${cacheKeySuffix}`;
    const cached = localStorage.getItem(cacheKey);
    
    if (cached) {
        try {
            const parsed = JSON.parse(cached);
            const minutesPassed = (new Date().getTime() - parsed.timestamp) / (1000 * 60);
            if (minutesPassed < CACHE_EXPIRATION_MINUTES) {
                return parsed.data; // Retorna caché si no ha expirado
            }
        } catch (e) {
            localStorage.removeItem(cacheKey);
        }
    }
    
    const response = await fetch(url, {
        headers: SUPABASE_HEADERS
    });
    
    if (!response.ok) throw new Error(`Error al conectar con Supabase: ${cacheKeySuffix}`);
    
    const data = await response.json();
    
    // Guardar en localStorage para próximas consultas
    localStorage.setItem(cacheKey, JSON.stringify({
        timestamp: new Date().getTime(),
        data: data
    }));
    
    return data;
}

/* ====================================================
   LÓGICA DEL CARRITO DE COMPRAS Y PERSISTENCIA
==================================================== */
function initCart() {
    checkCartExpiration();
    updateCartCounter();
}

function checkCartExpiration() {
    const cartData = localStorage.getItem(CART_KEY);
    if (cartData) {
        try {
            const cart = JSON.parse(cartData);
            const now = new Date().getTime();
            const hoursPassed = (now - cart.lastUpdated) / (1000 * 60 * 60);
            
            if (hoursPassed >= CART_EXPIRATION_HOURS) {
                localStorage.removeItem(CART_KEY);
                console.log("El carrito ha expirado por inactividad de 2 horas.");
            }
        } catch (e) {
            localStorage.removeItem(CART_KEY);
        }
    }
}

function getCart() {
    checkCartExpiration();
    const cartData = localStorage.getItem(CART_KEY);
    if (cartData) return JSON.parse(cartData);
    return { items: [], lastUpdated: new Date().getTime() };
}

function saveCart(cart) {
    cart.lastUpdated = new Date().getTime();
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    updateCartCounter();
}

function updateCartCounter() {
    const cart = getCart();
    const totalItems = cart.items.reduce((sum, item) => sum + item.cantidad, 0);
    const counters = document.querySelectorAll('#cart-counter');
    counters.forEach(counter => {
        counter.textContent = totalItems;
        counter.classList.add('scale-150');
        setTimeout(() => counter.classList.remove('scale-150'), 200);
    });
}

function agregarProductoAlCarrito(productoInfo, cantidadAAnadir) {
    const cart = getCart();
    const existingItemIndex = cart.items.findIndex(item => String(item.id) === String(productoInfo.id));
    
    if (existingItemIndex !== -1) {
        cart.items[existingItemIndex].cantidad += cantidadAAnadir;
    } else {
        cart.items.push({
            id: String(productoInfo.id),
            nombre: productoInfo.nombre,
            precio: productoInfo.precio,
            categoria: productoInfo.categoria,
            imagen: productoInfo.imagen,
            cantidad: cantidadAAnadir
        });
    }
    
    saveCart(cart);
}

window.añadirAlCarrito = function(idProducto, evento) {
    if (evento) evento.stopPropagation(); 
    
    const producto = baseDeDatosProductos.find(p => String(p.id) === String(idProducto));
    
    if (producto) {
        agregarProductoAlCarrito(producto, 1);
        const btn = evento ? evento.currentTarget : event.currentTarget;
        if(btn) {
            const originalHtml = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-check text-brand-glow"></i>';
            setTimeout(() => btn.innerHTML = originalHtml, 1000);
        }
    } else {
        alert("Para comprar este producto, por favor búscalo desde el Catálogo completo.");
        window.location.href = 'productos.html';
    }
}

/* ====================================================
   LÓGICA PÁGINA DEL CARRITO (carrito.html)
==================================================== */
function initCartPage() {
    renderCart();
}

function renderCart() {
    const cart = getCart();
    const container = document.getElementById('cart-items-container');
    const emptyMsg = document.getElementById('empty-cart-msg');
    const summaryContainer = document.getElementById('cart-summary');
    
    if(!container) return;
    container.innerHTML = '';
    
    if (cart.items.length === 0) {
        container.classList.add('hidden');
        summaryContainer.classList.add('hidden');
        emptyMsg.classList.remove('hidden');
        emptyMsg.classList.add('flex');
        return;
    }
    
    container.classList.remove('hidden');
    summaryContainer.classList.remove('hidden');
    emptyMsg.classList.add('hidden');
    emptyMsg.classList.remove('flex');
    
    let total = 0;
    
    cart.items.forEach((item) => {
        const subtotal = item.precio * item.cantidad;
        total += subtotal;
        
        const itemEl = document.createElement('div');
        itemEl.className = 'glass-card p-4 rounded-2xl flex flex-col sm:flex-row items-center gap-4';
        itemEl.innerHTML = `
            <div class="relative w-24 h-24 rounded-xl bg-white/5 flex-shrink-0 p-2 overflow-hidden">
                <img src="${item.imagen}" alt="${item.nombre}" loading="lazy" decoding="async" class="w-full h-full object-contain">
            </div>
            <div class="flex-grow text-center sm:text-left">
                <h3 class="text-lg font-bold leading-tight">${item.nombre}</h3>
                <p class="text-brand-glow font-medium">$${formatMoney(item.precio)} COP</p>
            </div>
            <div class="flex items-center gap-3 bg-white/5 rounded-xl p-2 mx-auto sm:mx-0">
                <button onclick="updateCartItemQty('${item.id}', -1)" class="w-8 h-8 flex justify-center items-center rounded-lg hover:bg-white/10 text-white transition-colors">-</button>
                <span class="w-6 text-center font-bold">${item.cantidad}</span>
                <button onclick="updateCartItemQty('${item.id}', 1)" class="w-8 h-8 flex justify-center items-center rounded-lg hover:bg-white/10 text-white transition-colors">+</button>
            </div>
            <div class="text-center sm:text-right sm:w-32">
                <p class="text-sm text-gray-400 hidden sm:block">Subtotal</p>
                <p class="font-bold text-lg">$${formatMoney(subtotal)}</p>
            </div>
            <button onclick="removeCartItem('${item.id}')" class="text-red-400 hover:text-red-300 p-3 transition-colors rounded-lg bg-red-500/10 hover:bg-red-500/20" title="Eliminar producto">
                <i class="fa-solid fa-trash"></i>
            </button>
        `;
        container.appendChild(itemEl);
    });
    
    document.getElementById('cart-total').textContent = `$${formatMoney(total)} COP`;
}

window.updateCartItemQty = function(id, change) {
    const cart = getCart();
    const item = cart.items.find(i => String(i.id) === String(id));
    if (item) {
        item.cantidad += change;
        if (item.cantidad <= 0) return removeCartItem(id);
        saveCart(cart);
        renderCart();
    }
}

window.removeCartItem = function(id) {
    const cart = getCart();
    cart.items = cart.items.filter(i => String(i.id) !== String(id));
    saveCart(cart);
    renderCart();
}

window.clearCart = function() {
    localStorage.removeItem(CART_KEY);
    updateCartCounter();
    renderCart();
}

window.checkoutWhatsApp = function() {
    const cart = getCart();
    if (cart.items.length === 0) return;
    
    let message = "Hola, me gustaría realizar el siguiente pedido:\n";
    let total = 0;
    
    cart.items.forEach(item => {
        message += `• ${item.cantidad}x ${item.nombre}\n`;
        total += (item.precio * item.cantidad);
    });
    
    message += "Quedo atento a la confirmación del pedido. ¡Muchas gracias!";
    
    const encodedMessage = encodeURIComponent(message);
    const phoneNumber = "573023848567"; // Remplazar por número local con indicativo
    
    window.open(`https://wa.me/${phoneNumber}?text=${encodedMessage}`, '_blank');
}

/* ====================================================
   CARGA CENTRALIZADA Y OPTIMIZADA DE PRODUCTOS
   - Solo se cargan productos con Disponible = true
     (regla aplicada directamente en la consulta REST,
     así ahorramos ancho de banda y automáticamente
     protege la página de detalle: un producto oculto
     nunca llega al array baseDeDatosProductos).
   - select= limita las columnas a las estrictamente
     necesarias (no se trae Disponible, ya filtrado).
==================================================== */
async function cargarProductosDesdeSupabase() {
    const gridContainer = document.getElementById('products-grid');
    if(gridContainer) {
        gridContainer.innerHTML = `
            <div class="col-span-full flex flex-col justify-center items-center py-20">
                <i class="fa-solid fa-circle-notch fa-spin text-5xl text-brand-glow mb-4"></i>
                <span class="text-gray-400 font-medium animate-pulse">Conectando con la base de datos...</span>
            </div>
        `;
        gridContainer.classList.remove('hidden');
    }

    try {
        const campos = 'id,Nombre,Precio,Categoria,Material,Descripcion,Imagen,Destacado';
        const url = `${SUPABASE_URL}${PRODUCTOS_TABLE}?select=${campos}&Disponible=eq.TRUE`;

        // Usa la función con caché en lugar de fetch directo
        const data = await fetchFromSupabaseWithCache(PRODUCTOS_TABLE, url);

        baseDeDatosProductos = data.map(fila => {
            // Soporte para múltiples imágenes: Supabase entrega Imagen como text[] (array de URLs).
            let imagenesArray = Array.isArray(fila.Imagen) ? fila.Imagen.filter(Boolean) : [];

            // La "imagen principal" es siempre Imagen[0], y se sigue exponiendo en el
            // campo 'imagen' tal como antes, para no romper catálogo/destacados/carrito.
            const imagenUrl = imagenesArray.length > 0 ? imagenesArray[0] : PLACEHOLDER_IMG;

            return {
                id: fila.id,
                nombre: fila.Nombre || 'Producto sin nombre',
                categoria: fila.Categoria ? fila.Categoria.trim().toLowerCase() : 'otros', 
                precio: fila.Precio || 0,
                descripcion: fila.Descripcion || 'Un increíble producto modelado e impreso en 3D con la mejor calidad.',
                imagen: imagenUrl,                                       // Imagen principal (compatibilidad: catálogo, destacados, carrito)
                imagenes: imagenesArray.length > 0 ? imagenesArray : [imagenUrl], // Galería completa (solo detalle de producto)
                material: fila.Material || null,       // Nuevo campo mapeado
                destacado: fila.Destacado === true     // Nuevo campo mapeado
            };
        });

        // Solo ejecutar si estamos en la página del catálogo
        if(gridContainer) {
            generarFiltrosDeCategoria();
            aplicarFiltros();
        }

    } catch (error) {
        console.error("Error cargando Supabase:", error);
        if(gridContainer) {
            gridContainer.innerHTML = `
                <div class="col-span-full text-center py-20 text-red-400">
                    <i class="fa-solid fa-triangle-exclamation text-5xl mb-4"></i>
                    <h3 class="text-2xl font-bold text-white mb-2">Error de conexión</h3>
                    <p>No se pudo cargar el catálogo. Verifica tus credenciales de Supabase o el nombre de la tabla.</p>
                </div>
            `;
        }
    }
}

/* ====================================================
   LÓGICA PÁGINA INICIO (index.html)
==================================================== */
async function initIndexPage() {
    // Animaciones iniciales (excluyendo el carrusel que se inyecta después)
    const cards = document.querySelectorAll('.glass-card:not(#featured-products-container .glass-card)');
    cards.forEach((card, index) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(30px)';
        setTimeout(() => {
            card.style.transition = 'all 0.6s cubic-bezier(0.16, 1, 0.3, 1)';
            card.style.opacity = '1';
            card.style.transform = 'translateY(0)';
        }, 150 * index);
    });

    await cargarProductosDesdeSupabase(); // Carga de BD
    renderDestacados(); // Genera carrusel dinámico

    // En cuanto la landing terminó lo importante, aprovechamos el tiempo
    // ocioso del navegador para dejar "tibias" las imágenes del catálogo.
    precargarImagenesCatalogoEnIdle();
}

// Variable global para controlar la automatización
let carouselInterval;

function renderDestacados() {
    const container = document.getElementById('featured-products-container');
    if (!container) return;
    
    const destacados = baseDeDatosProductos.filter(p => p.destacado);
    container.innerHTML = '';
    
    if (destacados.length === 0) {
        container.innerHTML = '<p class="text-gray-400 text-center w-full py-10">Pronto añadiremos productos destacados.</p>';
        return;
    }
    
    // Las primeras tarjetas son las que se ven sin desplazar el carrusel:
    // se piden con prioridad alta y sin lazy loading para que aparezcan
    // lo antes posible. El resto sigue usando loading="lazy".
    const DESTACADOS_PRIORITARIOS = 4;

    destacados.forEach((producto, index) => {
        const card = document.createElement('div');
        // CORRECCIÓN 2: Tamaños calculados y compactos según el breakpoint
        card.className = 'glass-card rounded-2xl overflow-hidden group flex flex-col flex-shrink-0 snap-start w-full sm:w-[calc(50%-0.5rem)] md:w-[calc(33.333%-0.66rem)] lg:w-[calc(25%-0.75rem)]';
        const esPrioritaria = index < DESTACADOS_PRIORITARIOS;
        const atributosCarga = esPrioritaria ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
        card.innerHTML = `
            <div onclick="verProducto('${producto.id}')" class="relative h-48 overflow-hidden p-4 flex justify-center items-center bg-white/5 cursor-pointer img-skeleton">
                <div class="absolute inset-0 bg-gradient-to-t from-brand-black to-transparent z-10 pointer-events-none"></div>
                <img src="${optimizarUrlImagenSupabase(producto.imagen, 500)}" alt="${producto.nombre}" ${atributosCarga} decoding="async" class="max-h-full object-contain relative z-0 group-hover:scale-110 img-carga-suave opacity-0" onload="this.classList.remove('opacity-0'); this.closest('.img-skeleton')?.classList.remove('img-skeleton')" onerror="this.onerror=null; this.src='${PLACEHOLDER_IMG}'; this.classList.remove('opacity-0'); this.closest('.img-skeleton')?.classList.remove('img-skeleton')">
            </div>
            <div class="p-5 flex-grow flex flex-col justify-between">
                <div class="flex justify-between items-start mb-3 gap-2">
                    <h3 onclick="verProducto('${producto.id}')" class="font-bold text-lg leading-tight line-clamp-2 cursor-pointer group-hover:text-brand-glow transition-colors">${producto.nombre}</h3>
                </div>
                <div class="flex justify-between items-center mt-auto pt-2 border-t border-white/5">
                    <span class="text-brand-glow font-bold whitespace-nowrap">$${formatMoney(producto.precio)}</span>
                    <button onclick="añadirAlCarrito('${producto.id}', event)" class="bg-white/5 hover:bg-brand-blue text-white p-2 rounded-lg transition-colors shadow-sm" title="Añadir al carrito">
                        <i class="fa-solid fa-cart-plus"></i>
                    </button>
                </div>
            </div>
        `;
        container.appendChild(card);
    });

    // Iniciar la lógica de movimiento tras inyectar las tarjetas
    initCarouselLogic();
}

function initCarouselLogic() {
    const container = document.getElementById('featured-products-container');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    
    if (!container) return;
    
    // Calcula cuánto deslizar (el ancho de una tarjeta visible + gap)
    const scrollAmount = () => {
        const firstCard = container.querySelector('.glass-card');
        return firstCard ? firstCard.offsetWidth + 16 : 300; 
    };

    const scrollNext = () => {
        if (container.scrollLeft + container.clientWidth >= container.scrollWidth - 10) {
            container.scrollTo({ left: 0, behavior: 'smooth' }); // Vuelve al inicio si llegó al final
        } else {
            container.scrollBy({ left: scrollAmount(), behavior: 'smooth' });
        }
    };

    const scrollPrev = () => {
        if (container.scrollLeft <= 0) {
            container.scrollTo({ left: container.scrollWidth, behavior: 'smooth' });
        } else {
            container.scrollBy({ left: -scrollAmount(), behavior: 'smooth' });
        }
    };

    // Navegación Manual
    if (nextBtn) nextBtn.addEventListener('click', () => { scrollNext(); startCarousel(); });
    if (prevBtn) prevBtn.addEventListener('click', () => { scrollPrev(); startCarousel(); });

    // Navegación Automática
    const startCarousel = () => {
        clearInterval(carouselInterval);
        carouselInterval = setInterval(scrollNext, 4000); // Se mueve cada 4 segundos
    };

    // Pausar si el usuario pone el mouse encima para no interrumpir lectura
    const wrapper = container.parentElement;
    if (wrapper) {
        wrapper.addEventListener('mouseenter', () => clearInterval(carouselInterval));
        wrapper.addEventListener('mouseleave', startCarousel);
    }

    startCarousel();
}


/* ====================================================
   LÓGICA PÁGINA CATÁLOGO (productos.html)
==================================================== */
function initCatalogPage() {
    cargarProductosDesdeSupabase();
    const searchInput = document.getElementById('searchInput');
    if(searchInput) {
        searchInput.addEventListener('input', (e) => {
            busquedaActual = e.target.value;
            aplicarFiltros();
        });
    }
}

function generarFiltrosDeCategoria() {
    const container = document.getElementById('category-filters');
    if(!container) return;
    container.innerHTML = ''; 

    const btnTodos = document.createElement('button');
    btnTodos.className = 'filter-btn active text-left px-4 py-2 rounded-xl border border-white/10 hover:bg-white/5 transition-all text-sm';
    btnTodos.setAttribute('data-category', 'todos');
    btnTodos.textContent = 'Todos los productos';
    container.appendChild(btnTodos);

    const categoriasUnicas = [...new Set(baseDeDatosProductos.map(p => p.categoria))].filter(c => c !== 'todos' && c !== 'otros' && c !== '');
    
    const todasLasCategorias = [...categoriasUnicas];
    if (baseDeDatosProductos.some(p => p.categoria === 'otros')) todasLasCategorias.push('otros');

    todasLasCategorias.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = 'filter-btn text-left px-4 py-2 rounded-xl border border-white/10 hover:bg-white/5 transition-all text-sm capitalize';
        btn.setAttribute('data-category', cat);
        btn.textContent = cat;
        container.appendChild(btn);
    });

    const nuevosFiltrosBtns = document.querySelectorAll('.filter-btn');
    nuevosFiltrosBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            nuevosFiltrosBtns.forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            categoriaActual = e.currentTarget.getAttribute('data-category');
            aplicarFiltros();
        });
    });
}

function aplicarFiltros() {
    const resultados = baseDeDatosProductos.filter(producto => {
        const coincideCategoria = (categoriaActual === 'todos') || (producto.categoria === categoriaActual);
        const textoBusqueda = busquedaActual.toLowerCase();
        const coincideTexto = producto.nombre.toLowerCase().includes(textoBusqueda);
        return coincideCategoria && coincideTexto;
    });
    renderizarProductos(resultados);
}

function renderizarProductos(productos) {
    const gridContainer = document.getElementById('products-grid');
    const noResultsMsg = document.getElementById('no-results');
    if(!gridContainer) return;
    
    gridContainer.innerHTML = '';

    if (productos.length === 0 && baseDeDatosProductos.length > 0) {
        gridContainer.classList.add('hidden');
        if(noResultsMsg) noResultsMsg.classList.remove('hidden');
        return;
    } else {
        gridContainer.classList.remove('hidden');
        if(noResultsMsg) noResultsMsg.classList.add('hidden');
    }

    // Las primeras tarjetas del catálogo son las que se ven "sin hacer scroll"
    // en la mayoría de pantallas: se cargan con prioridad alta y sin lazy
    // loading para que no se sientan "en blanco" al entrar a la página.
    // El resto conserva loading="lazy" (beneficioso: no se descargan hasta
    // que el usuario se acerca a ellas).
    const PRODUCTOS_PRIORITARIOS = 6;

    productos.forEach((producto, index) => {
        const card = document.createElement('div');
        card.className = 'glass-card rounded-3xl overflow-hidden group flex flex-col';
        const esPrioritaria = index < PRODUCTOS_PRIORITARIOS;
        const atributosCarga = esPrioritaria ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
        card.innerHTML = `
            <div onclick="verProducto('${producto.id}')" class="relative h-56 overflow-hidden p-4 flex justify-center items-center bg-white/5 cursor-pointer img-skeleton">
                <div class="absolute inset-0 bg-gradient-to-t from-brand-black to-transparent z-10 pointer-events-none"></div>
                <img src="${optimizarUrlImagenSupabase(producto.imagen, 500)}" alt="${producto.nombre}" ${atributosCarga} decoding="async" class="max-h-full object-contain relative z-0 group-hover:scale-110 img-carga-suave opacity-0 drop-shadow-xl" onload="this.classList.remove('opacity-0'); this.closest('.img-skeleton')?.classList.remove('img-skeleton')" onerror="this.onerror=null; this.src='${PLACEHOLDER_IMG}'; this.classList.remove('opacity-0'); this.closest('.img-skeleton')?.classList.remove('img-skeleton')">
            </div>
            <div class="p-5 flex-grow flex flex-col justify-between">
                <div onclick="verProducto('${producto.id}')" class="cursor-pointer">
                    <h3 class="text-lg font-bold mb-1 leading-tight group-hover:text-brand-glow transition-colors">${producto.nombre}</h3>
                </div>
                <div class="flex items-center justify-between mt-4">
                    <div>
                        <span class="text-xl font-bold text-white">$${formatMoney(producto.precio)}</span>
                    </div>
                    <button onclick="añadirAlCarrito('${producto.id}', event)" class="bg-white/10 hover:bg-brand-blue text-white w-10 h-10 flex justify-center items-center rounded-xl transition-all hover:scale-105 active:scale-95 z-20 relative" title="Añadir al carrito">
                        <i class="fa-solid fa-cart-plus"></i>
                    </button>
                </div>
            </div>
        `;
        gridContainer.appendChild(card);
    });
}

window.verProducto = function(idProducto) {
    window.location.href = `producto.html?id=${encodeURIComponent(idProducto)}`;
}

/* ====================================================
   LÓGICA PÁGINA DE DETALLE (producto.html)
==================================================== */
async function initProductPage() {
    // Al usar la caché, cargar toda la DB es más rápido y ahorramos la consulta individual a la API
    await cargarProductosDesdeSupabase(); 
    cargarProducto();
}

function obtenerIdDeLaUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('id');
}

function cargarProducto() {
    const productoId = obtenerIdDeLaUrl();

    if (!productoId) {
        mostrarErrorProducto();
        return;
    }

    productoActual = baseDeDatosProductos.find(p => String(p.id) === String(productoId));

    if (!productoActual) {
        mostrarErrorProducto();
        return;
    }

    mostrarProductoEnPantalla();
    generarColoresDisponibles(productoActual); // Disparar búsqueda de colores
}

function mostrarErrorProducto() {
    const loader = document.getElementById('loader');
    if(loader) loader.classList.add('hidden');
    const errorMsg = document.getElementById('error-msg');
    if(errorMsg) {
        errorMsg.classList.remove('hidden');
        errorMsg.classList.add('flex');
    }
}

function mostrarProductoEnPantalla() {
    const loader = document.getElementById('loader');
    if(loader) loader.classList.add('hidden');
    const container = document.getElementById('product-container');
    if(container) container.classList.remove('hidden');

    document.getElementById('prod-name').textContent = productoActual.nombre;
    document.getElementById('prod-cat').textContent = productoActual.categoria;
    document.getElementById('prod-price').textContent = formatMoney(productoActual.precio);
    inicializarGaleria(productoActual.imagenes);

    const descElement = document.getElementById('prod-desc');
    const seccionDesc = document.getElementById('seccion-descripcion');
    
    // Validar si la descripción existe y no está compuesta solo por espacios
    if (productoActual.descripcion && productoActual.descripcion.trim() !== '') {
        descElement.innerHTML = productoActual.descripcion.replace(/\n/g, '<br>');
        if (seccionDesc) seccionDesc.classList.remove('hidden');
    } else {
        if (seccionDesc) seccionDesc.classList.add('hidden'); // Ocultar bloque completo sin dejar huecos
    }

    const btnCart = document.getElementById('btn-add-cart');
    if(btnCart) {
        btnCart.onclick = function() {
            agregarProductoAlCarrito(productoActual, cantidadActual);

            const originalHtml = this.innerHTML;
            this.innerHTML = '<i class="fa-solid fa-check"></i> ¡Añadido!';
            this.classList.replace('from-brand-blue', 'from-green-500');
            this.classList.replace('to-brand-glow', 'to-green-400');
            
            setTimeout(() => {
                this.innerHTML = originalHtml;
                this.classList.replace('from-green-500', 'from-brand-blue');
                this.classList.replace('to-green-400', 'to-brand-glow');
            }, 1500);
        };
    }
}

window.cambiarCantidad = function(cambio) {
    let nuevaCantidad = cantidadActual + cambio;
    if (nuevaCantidad >= 1 && nuevaCantidad <= 20) {
        cantidadActual = nuevaCantidad;
        document.getElementById('prod-qty').textContent = cantidadActual;
    }
}

/* ====================================================
   GALERÍA DE IMÁGENES DEL PRODUCTO (Detalle)
   - Soporta 1 o múltiples imágenes por producto.
   - Solo muestra flechas/indicadores si hay más de 1 imagen.
   - Precarga únicamente la imagen siguiente y anterior (no todas)
     para evitar descargas innecesarias, reutilizando el caché
     del navegador al navegar entre imágenes.
==================================================== */
function inicializarGaleria(imagenes) {
    galeriaImagenes = (imagenes && imagenes.length > 0) ? imagenes : [productoActual.imagen];
    indiceImagenActual = 0;

    const flechas = document.querySelectorAll('.gallery-arrow');
    const indicadoresContainer = document.getElementById('gallery-indicators');

    if (galeriaImagenes.length > 1) {
        flechas.forEach(f => f.classList.remove('hidden'));
        renderizarIndicadoresGaleria();
    } else {
        flechas.forEach(f => f.classList.add('hidden'));
        if (indicadoresContainer) indicadoresContainer.innerHTML = '';
    }

    actualizarImagenGaleria();
}

function actualizarImagenGaleria() {
    const prodImg = document.getElementById('prod-img');
    if (!prodImg || galeriaImagenes.length === 0) return;

    // Mientras llega la nueva imagen, mostramos de nuevo el skeleton y
    // ocultamos la imagen (evita ver el "salto" entre la imagen anterior
    // y la nueva, o un hueco vacío si la imagen aún no está en caché).
    const wrapper = prodImg.parentElement;
    if (wrapper) wrapper.classList.add('img-skeleton');
    prodImg.classList.add('opacity-0');

    const ocultarSkeleton = () => {
        prodImg.classList.remove('opacity-0');
        if (wrapper) wrapper.classList.remove('img-skeleton');
    };
    prodImg.addEventListener('load', ocultarSkeleton, { once: true });
    prodImg.addEventListener('error', function alError() {
        prodImg.onerror = null;
        prodImg.src = PLACEHOLDER_IMG;
    }, { once: true });

    prodImg.src = optimizarUrlImagenSupabase(galeriaImagenes[indiceImagenActual], 900);
    prodImg.alt = productoActual ? productoActual.nombre : 'Producto';

    precargarImagenesAdyacentes();
    actualizarIndicadoresActivos();
}

function precargarImagenesAdyacentes() {
    // Solo precarga la imagen siguiente y la anterior (no toda la galería),
    // así el cambio se siente instantáneo sin descargar imágenes de más.
    if (galeriaImagenes.length <= 1) return;

    const siguiente = (indiceImagenActual + 1) % galeriaImagenes.length;
    const anterior = (indiceImagenActual - 1 + galeriaImagenes.length) % galeriaImagenes.length;

    [siguiente, anterior].forEach(idx => {
        const imgPrecarga = new Image();
        imgPrecarga.src = optimizarUrlImagenSupabase(galeriaImagenes[idx], 900); // El navegador la cachea para uso inmediato
    });
}

window.cambiarImagenGaleria = function(direccion) {
    if (galeriaImagenes.length <= 1) return;
    indiceImagenActual = (indiceImagenActual + direccion + galeriaImagenes.length) % galeriaImagenes.length;
    actualizarImagenGaleria();
}

window.irAImagenGaleria = function(indice) {
    if (indice < 0 || indice >= galeriaImagenes.length) return;
    indiceImagenActual = indice;
    actualizarImagenGaleria();
}

function renderizarIndicadoresGaleria() {
    const container = document.getElementById('gallery-indicators');
    if (!container) return;
    container.innerHTML = '';

    galeriaImagenes.forEach((_, idx) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'gallery-dot';
        dot.setAttribute('aria-label', `Ver imagen ${idx + 1} de ${galeriaImagenes.length}`);
        dot.onclick = () => irAImagenGaleria(idx);
        container.appendChild(dot);
    });

    actualizarIndicadoresActivos();
}

function actualizarIndicadoresActivos() {
    const container = document.getElementById('gallery-indicators');
    if (!container) return;
    const dots = container.querySelectorAll('.gallery-dot');
    dots.forEach((dot, idx) => {
        dot.classList.toggle('active', idx === indiceImagenActual);
    });
}

/* ====================================================
   GENERACIÓN DE COLORES PARA EL PRODUCTO
   - Cada material (PLA, PETG, ...) es ahora una tabla en
     Supabase con columnas: Nombre, Color (text[]), Disponible.
   - Color ya no es un string "#A/#B", sino un array de hex:
     ["#A"] (sólido), ["#A","#B"] (bicolor), etc.
   - Se dibuja un círculo dividido equitativamente en tantas
     secciones como colores tenga el array (conic-gradient),
     lo que soporta 1, 2, 3 o cualquier cantidad de colores
     (bicolor, tricolor, rainbow/multicolor).
==================================================== */
async function generarColoresDisponibles(producto) {
    const seccionColores = document.getElementById('seccion-colores');
    const container = document.getElementById('colores-container');
    const labelMaterial = document.getElementById('prod-material');
    
    // Solo continuar si el HTML está preparado y el producto tiene un material asignado
    if (!seccionColores || !producto.material) return;
    
    seccionColores.classList.remove('hidden');
    if(labelMaterial) labelMaterial.textContent = producto.material;
    if(container) container.innerHTML = '<div class="flex items-center gap-2 text-brand-glow"><i class="fa-solid fa-circle-notch fa-spin"></i> Cargando colores...</div>';
    
    try {
        const materialTable = producto.material.trim().toUpperCase(); 
        const url = `${SUPABASE_URL}${materialTable}?select=Nombre,Color,Disponible`;
        // No se filtra por Disponible: los colores no disponibles se siguen
        // mostrando (desaturados y tachados), solo se ocultan los productos.
        const data = await fetchFromSupabaseWithCache(`material_${materialTable}`, url);
        
        if(container) container.innerHTML = '';
        
        if (!data || data.length === 0) {
            if(container) container.innerHTML = '<span class="text-sm text-gray-400">No hay colores registrados.</span>';
            return;
        }
        
        data.forEach(fila => {
            const colorDiv = document.createElement('div');
            
            colorDiv.className = 'w-10 h-10 rounded-full shadow-md relative group cursor-help border-2 border-white/10 transition-transform hover:scale-110 flex-shrink-0';
            
            // Renderizado equitativo para 1, 2, 3 o más colores
            const colores = Array.isArray(fila.Color) ? fila.Color.filter(Boolean) : [];
            colorDiv.style.background = generarFondoColores(colores);
            
            // Tratamiento de No Disponibles (desaturado + línea roja, vía CSS)
            if (fila.Disponible === false) {
                colorDiv.classList.add('color-unavailable');
            }
            
            // Tooltip construido con Tailwind
            const tooltip = document.createElement('span');
            tooltip.className = 'absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 bg-brand-black border border-white/10 text-white text-xs font-bold rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-20 shadow-xl';
            tooltip.textContent = fila.Nombre || 'Desconocido';
            
            const arrow = document.createElement('div');
            arrow.className = 'absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-brand-black';
            tooltip.appendChild(arrow);
            
            colorDiv.appendChild(tooltip);
            if(container) container.appendChild(colorDiv);
        });
        
    } catch (error) {
        console.error("Error cargando tabla de colores:", error);
        if(container) container.innerHTML = '<span class="text-sm text-red-400">Error de conexión con la paleta.</span>';
    }
}

// Construye el valor CSS 'background' para un array de colores hex:
// - 0 colores  -> gris neutro de respaldo
// - 1 color    -> color sólido
// - 2+ colores -> conic-gradient dividido en partes iguales (pastel/pie)
function generarFondoColores(colores) {
    if (!colores || colores.length === 0) return '#cccccc';
    if (colores.length === 1) return colores[0];

    const segmento = 100 / colores.length;
    const partes = colores.map((color, idx) => {
        const inicio = (segmento * idx).toFixed(2);
        const fin = (segmento * (idx + 1)).toFixed(2);
        return `${color} ${inicio}% ${fin}%`;
    });

    return `conic-gradient(${partes.join(', ')})`;
}