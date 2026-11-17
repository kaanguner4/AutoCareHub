// --- CONFIGURATION ---
// Same-origin API: the pages and the API are served by the same Express app.
const API_URL = '/api';

const STATUS_LABELS = {
    pending: 'Pending', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show'
};
const CATEGORY_LABELS = {
    maintenance: 'Maintenance', tyres: 'Tyres', brakes: 'Brakes', ac: 'Air conditioning', electrical: 'Electrical',
    engine: 'Engine', bodywork: 'Bodywork', diagnostics: 'Diagnostics'
};

// Escape every value that goes into innerHTML.
function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function formatTRY(amount) {
    return Number(amount || 0).toLocaleString('tr-TR', { maximumFractionDigits: 0 }) + ' ₺';
}
function formatDate(value, withTime = false) {
    const opts = { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Europe/Istanbul' };
    if (withTime) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
    return new Date(value).toLocaleString('en-GB', opts);
}
function currentPage() {
    const last = window.location.pathname.split('/').pop();
    return last || 'index.html';
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async function() {
    setupEventListeners();
    const page = currentPage();
    if (page === 'admin.html') return; // admin.js handles the admin console

    const user = await API.me();
    if (['dashboard.html', 'appointment.html'].includes(page)) {
        if (!user) { window.location.href = 'index.html'; return; }
        if (user.role === 'admin') { window.location.href = 'admin.html'; return; }
    }
    if (user) {
        document.querySelectorAll('.navbar-text-user').forEach(el => el.textContent = user.name);
    }

    if (page === 'dashboard.html') await renderUserDashboard();
    if (page === 'appointment.html') await initAppointmentPage();
    if (page === 'register.html') await populateCitySelect();
});

// --- PARALLAX EFFECT ---
window.addEventListener('scroll', function() {
    const scrollPosition = window.scrollY;
    const heroImage = document.getElementById('heroImage');
    if (heroImage) {
        const scaleValue = 1 + (scrollPosition * 0.0005);
        const translateY = scrollPosition * 0.4;
        heroImage.style.transform = `translate3d(0, ${translateY}px, 0) scale(${scaleValue})`;
    }
});

// --- 1. API LAYER (sign-in state lives in an httpOnly cookie, not in the browser storage) ---
async function apiFetch(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${API_URL}${path}`, {
        method,
        credentials: 'same-origin',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
        const err = new Error((data && data.error) || 'Request failed. Please try again.');
        err.status = res.status;
        throw err;
    }
    return data;
}

const API = {
    me: async () => {
        try { return (await apiFetch('/me')).user; } catch (e) { return null; }
    },
    register: (userData) => apiFetch('/register', { method: 'POST', body: userData }),
    login: async (email, password) => (await apiFetch('/login', { method: 'POST', body: { email, password } })).user,
    logout: () => apiFetch('/logout', { method: 'POST' }).catch(() => null),
    getBranches: () => apiFetch('/branches'),
    getServices: () => apiFetch('/services'),
    getMyVehicles: () => apiFetch('/vehicles'),
    addVehicle: (vehicleData) => apiFetch('/vehicles', { method: 'POST', body: vehicleData }),
    deleteVehicle: (vehicleId) => apiFetch(`/vehicles/${encodeURIComponent(vehicleId)}`, { method: 'DELETE' }),
    createAppointment: (appData) => apiFetch('/appointments', { method: 'POST', body: appData }),
    getAppointments: (view = 'all', limit = 20) => apiFetch(`/appointments?view=${view}&limit=${limit}`),
    setAppointmentStatus: (appId, status) =>
        apiFetch(`/appointments/${encodeURIComponent(appId)}/status`, { method: 'PUT', body: { status } })
};

// --- 2. AUTHENTICATION ---
async function handleRegister(e) {
    e.preventDefault();
    const payload = {
        name: document.getElementById('regName').value,
        email: document.getElementById('regEmail').value,
        phone: document.getElementById('regPhone').value,
        city: document.getElementById('regCity').value,
        password: document.getElementById('regPassword').value
    };
    try {
        await API.register(payload);
        showNotification("Registration successful! Please sign in.", "success");
        setTimeout(() => { window.location.href = 'index.html'; }, 2000);
    } catch (err) {
        showNotification(err.status ? err.message : "Server error! Please try again.", "error");
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const emailInput = document.querySelector('#loginForm input[type="email"]');
    const passwordInput = document.querySelector('#loginForm input[type="password"]');
    if (!emailInput || !passwordInput) return;
    try {
        const user = await API.login(emailInput.value, passwordInput.value);
        window.location.href = user.role === 'admin' ? 'admin.html' : 'dashboard.html';
    } catch (err) {
        showNotification(err.status ? err.message : "Connection failed. Is the server running?", "error");
    }
}

async function populateCitySelect() {
    const select = document.getElementById('regCity');
    if (!select) return;
    try {
        const cities = [...new Set((await API.getBranches()).map(b => b.city))];
        cities.forEach(city => select.add(new Option(city, city)));
    } catch (err) { showNotification("Could not load the city list.", "error"); }
}

// --- 3. DASHBOARD & OPERATIONS ---
async function renderUserDashboard() {
    let myVehicles = [];
    let myAppointments = [];
    try {
        [myVehicles, myAppointments] = await Promise.all([API.getMyVehicles(), API.getAppointments('all', 20)]);
    } catch (err) {
        showNotification(err.message, "error");
        return;
    }

    const countEl = document.getElementById('totalCarsCount');
    if (countEl) countEl.textContent = myVehicles.length;

    const nextServiceEl = document.getElementById('nextServiceDate');
    if (nextServiceEl) {
        const now = Date.now();
        const upcoming = myAppointments
            .filter(app => ['pending', 'confirmed'].includes(app.status) && new Date(app.scheduled_for) >= now)
            .sort((a, b) => new Date(a.scheduled_for) - new Date(b.scheduled_for));
        nextServiceEl.textContent = upcoming.length > 0
            ? new Date(upcoming[0].scheduled_for).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'Europe/Istanbul' })
            : "-";
    }

    const vContainer = document.getElementById('vehicleContainer');
    if (vContainer) {
        vContainer.innerHTML = '';
        if (myVehicles.length === 0) {
            vContainer.innerHTML = `
                <div class="col-12">
                    <div class="empty-state-box text-center p-5 border border-secondary rounded" style="background: #111;">
                        <i class="fa-solid fa-car-tunnel text-muted fa-3x mb-3"></i>
                        <h5 class="fw-bold text-white">Garage Empty</h5>
                        <button class="btn btn-outline-primary mt-3" data-bs-toggle="modal" data-bs-target="#addVehicleModal">
                            <i class="fa-solid fa-plus me-2"></i>Add Machine
                        </button>
                    </div>
                </div>`;
        } else {
            vContainer.innerHTML = myVehicles.map(v => `
                <div class="vehicle-card-wide">
                    <div class="d-flex align-items-center">
                        <div class="v-icon-box"><i class="fa-solid fa-car"></i></div>
                        <div class="v-details"><h4>${esc(v.model)}</h4><span class="text-uppercase">${esc(v.brand)} · ${esc(v.model_year)}</span></div>
                    </div>
                    <div class="d-flex align-items-center gap-4">
                        <div class="v-plate d-none d-md-block">${esc(v.plate)}</div>
                        <button class="btn btn-sm text-danger border-0" data-action="delete-vehicle" data-id="${esc(v.id)}"><i class="fa-solid fa-trash-can fa-lg"></i></button>
                    </div>
                </div>`).join('');
        }
    }
    renderAppointmentTimeline(myAppointments);
}

function renderAppointmentTimeline(appointments) {
    const timelineContainer = document.getElementById('appointmentTimeline');
    if (!timelineContainer) return;
    timelineContainer.innerHTML = '';

    const activeAppointments = appointments.filter(app => app.status !== 'cancelled');
    if (activeAppointments.length === 0) {
        timelineContainer.innerHTML = `<div class="text-center text-muted py-4 border border-secondary rounded bg-dark"><p class="m-0">No active appointments.</p></div>`;
        return;
    }
    activeAppointments.sort((a, b) => new Date(b.scheduled_for) - new Date(a.scheduled_for));

    const now = Date.now();
    let html = '<div class="timeline">';
    activeAppointments.forEach(app => {
        const isOpen = ['pending', 'confirmed'].includes(app.status);
        const statusColor = isOpen ? 'status-pending' : 'status-success';
        const carName = `${app.vehicle.brand} ${app.vehicle.model} (${app.vehicle.plate}) · ${app.branch.name}`;
        const serviceName = app.services || 'Service appointment';
        const canCancel = isOpen && new Date(app.scheduled_for) > now;
        const actionBtn = canCancel ? `<button class="btn btn-sm btn-outline-danger ms-auto" style="font-size: 0.7rem;" data-action="cancel-appointment" data-id="${esc(app.id)}">CANCEL</button>` : '';

        html += `
        <div class="timeline-item">
            <div class="timeline-dot"></div>
            <div class="timeline-content">
                <span class="timeline-date"><i class="fa-regular fa-calendar me-2"></i>${esc(formatDate(app.scheduled_for, true))}</span>
                <div class="d-flex justify-content-between align-items-start mt-1">
                    <div>
                        <h6 class="fw-bold text-white mb-1">${esc(serviceName)}</h6>
                        <small class="text-muted d-block mb-2">${esc(carName)}</small>
                        <div class="d-flex align-items-center"><span class="status-indicator ${statusColor}"></span><small class="text-white">${esc(STATUS_LABELS[app.status] || app.status)}</small></div>
                    </div>
                    ${actionBtn}
                </div>
            </div>
        </div>`;
    });
    html += '</div>';
    timelineContainer.innerHTML = html;
}

async function handleAddVehicle(e) {
    e.preventDefault();
    const newVehicle = {
        brand: document.getElementById('newCarBrand').value,
        model: document.getElementById('newCarModel').value,
        plate: document.getElementById('newCarPlate').value,
        model_year: document.getElementById('newCarYear').value,
        fuel: document.getElementById('newCarFuel').value,
        mileage_km: document.getElementById('newCarMileage').value
    };
    try {
        await API.addVehicle(newVehicle);
        bootstrap.Modal.getInstance(document.getElementById('addVehicleModal')).hide();
        e.target.reset();
        await renderUserDashboard();
        showNotification("Vehicle added.", "success");
    } catch (err) { showNotification(err.status ? err.message : "Error adding vehicle.", "error"); }
}

async function deleteVehicle(id) {
    if (!confirm('Delete this vehicle?')) return;
    try {
        await API.deleteVehicle(id);
        await renderUserDashboard();
        showNotification("Vehicle deleted.", "success");
    } catch (err) { showNotification(err.message, "error"); }
}

// --- 4. BOOKING ---
const SLOTS = { weekday: ['08:30', '17:30'], saturday: ['08:30', '13:30'] };

function timeSlots(dateValue) {
    if (!dateValue) return [];
    const weekday = new Date(`${dateValue}T12:00:00Z`).getUTCDay();
    if (weekday === 0) return [];
    const [from, to] = weekday === 6 ? SLOTS.saturday : SLOTS.weekday;
    const toMinutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const out = [];
    for (let m = toMinutes(from); m <= toMinutes(to); m += 30) {
        out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    }
    return out;
}

function populateTimeSelect() {
    const dateInput = document.getElementById('dateInput');
    const select = document.getElementById('timeSelect');
    if (!dateInput || !select) return;
    const slots = timeSlots(dateInput.value);
    select.innerHTML = '';
    select.add(new Option(slots.length ? 'Select...' : (dateInput.value ? 'Closed on Sundays' : 'Select a date first'), ''));
    select.options[0].disabled = true;
    select.options[0].selected = true;
    slots.forEach(slot => select.add(new Option(slot, slot)));
}

async function initAppointmentPage() {
    const dateInput = document.getElementById('dateInput');
    if (dateInput) {
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
        dateInput.setAttribute('min', today);
        dateInput.addEventListener('change', populateTimeSelect);
        populateTimeSelect();
    }
    await Promise.all([populateCarSelect(), populateBranchSelect(), renderServiceList()]);
}

async function populateBranchSelect() {
    const select = document.getElementById('branchSelect');
    if (!select) return;
    try {
        (await API.getBranches()).forEach(b => select.add(new Option(`${b.name} (${b.district}, ${b.city})`, b.id)));
    } catch (err) { showNotification("Could not load the branches.", "error"); }
}

async function renderServiceList() {
    const list = document.getElementById('serviceList');
    if (!list) return;
    let services = [];
    try { services = await API.getServices(); } catch (err) { showNotification("Could not load the services.", "error"); return; }
    list.innerHTML = services.map(s => `
        <label class="list-group-item d-flex gap-3 align-items-center">
            <input class="form-check-input flex-shrink-0 service-checkbox" type="checkbox" value="${esc(s.id)}" data-price="${esc(s.list_price_try)}" style="width: 1.5em; height: 1.5em;">
            <div class="d-flex w-100 justify-content-between align-items-center service-info">
                <div>
                    <h6 class="mb-0">${esc(s.name)}</h6>
                    <small class="text-muted">${esc(CATEGORY_LABELS[s.category] || s.category)} · ~${esc(s.standard_labor_hours)} h</small>
                </div>
                <span class="service-price-tag">${esc(formatTRY(s.list_price_try))}</span>
            </div>
        </label>`).join('');
}

function updatePriceDisplay() {
    const priceDisplay = document.getElementById('priceDisplay');
    if (!priceDisplay) return;
    let total = 0;
    document.querySelectorAll('.service-checkbox:checked').forEach(c => total += Number(c.dataset.price));
    priceDisplay.textContent = formatTRY(total);
}

async function handleAppointmentSubmit(e) {
    e.preventDefault();
    const carSelect = document.getElementById('carSelect');
    const branchSelect = document.getElementById('branchSelect');
    const dateInput = document.getElementById('dateInput');
    const timeSelect = document.getElementById('timeSelect');
    const noteInput = document.getElementById('noteInput');
    const serviceIds = [...document.querySelectorAll('.service-checkbox:checked')].map(box => box.value);

    if (!carSelect.value || !branchSelect.value || !dateInput.value || !timeSelect.value || serviceIds.length === 0) {
        showNotification("Please fill all fields.", "error");
        return;
    }
    const newApp = {
        vehicle_id: carSelect.value,
        branch_id: branchSelect.value,
        date: dateInput.value,
        time: timeSelect.value,
        service_ids: serviceIds,
        note: noteInput ? noteInput.value : ''
    };
    try {
        await API.createAppointment(newApp);
        new bootstrap.Modal(document.getElementById('successModal')).show();
        e.target.reset();
        populateTimeSelect();
        updatePriceDisplay();
    } catch (err) { showNotification(err.status ? err.message : "Failed to create appointment.", "error"); }
}

async function cancelAppointment(id) {
    if (!confirm('Cancel appointment?')) return;
    try {
        await API.setAppointmentStatus(id, 'cancelled');
        await renderUserDashboard();
        showNotification("Appointment cancelled.", "success");
    } catch (err) { showNotification(err.message, "error"); }
}

async function populateCarSelect() {
    const select = document.getElementById('carSelect');
    if (!select) return;
    let myVehicles = [];
    try { myVehicles = await API.getMyVehicles(); } catch (err) { showNotification(err.message, "error"); return; }
    if (myVehicles.length === 0) {
        new bootstrap.Modal(document.getElementById('noCarsModal')).show();
        return;
    }
    myVehicles.forEach(v => select.add(new Option(`${v.brand} ${v.model} (${v.plate})`, v.id)));
}

function checkCarsBeforeAppointment(e) { e.preventDefault(); window.location.href = 'appointment.html'; }
function redirectToAddVehicle() { window.location.href = 'dashboard.html'; }

function showNotification(message, type = 'success') {
    const toastEl = document.getElementById('liveToast');
    if (!toastEl) return;
    document.getElementById('toastMessage').textContent = message;
    const toast = new bootstrap.Toast(toastEl);
    toast.show();
}

function setupEventListeners() {
    const on = (id, event, handler) => { const el = document.getElementById(id); if (el) el.addEventListener(event, handler); };
    on('registerForm', 'submit', handleRegister);
    on('loginForm', 'submit', handleLogin);
    on('addVehicleForm', 'submit', handleAddVehicle);
    on('appointmentForm', 'submit', handleAppointmentSubmit);
    on('serviceList', 'change', updatePriceDisplay);
    on('bookServiceBtn', 'click', checkCarsBeforeAppointment);
    on('addVehicleRedirectBtn', 'click', redirectToAddVehicle);
    on('logoutBtn', 'click', async (e) => {
        e.preventDefault();
        await API.logout();
        window.location.href = 'index.html';
    });
    on('vehicleContainer', 'click', (e) => {
        const btn = e.target.closest('[data-action="delete-vehicle"]');
        if (btn) deleteVehicle(btn.dataset.id);
    });
    on('appointmentTimeline', 'click', (e) => {
        const btn = e.target.closest('[data-action="cancel-appointment"]');
        if (btn) cancelAppointment(btn.dataset.id);
    });
}
