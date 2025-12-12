// --- CONFIGURATION ---
const API_URL = 'http://localhost:3000/api';

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async function() {
    checkAuthStatus();     
    setupEventListeners(); 
    
    // Sayfa özel yüklemeler
    if (window.location.pathname.includes('dashboard.html')) {
        await renderUserDashboard();
    }
    if (window.location.pathname.includes('appointment.html')) {
        await populateCarSelect();
        const dateInput = document.getElementById('dateInput');
        if (dateInput) {
            const today = new Date().toISOString().split('T')[0];
            dateInput.setAttribute('min', today);
        }
    }
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

// --- 1. API & AUTH LAYER (Backend İletişimi) ---
const API = {
    getCurrentUser: () => JSON.parse(localStorage.getItem('currentUser')),
    setCurrentUser: (user) => localStorage.setItem('currentUser', JSON.stringify(user)),
    logout: () => localStorage.removeItem('currentUser'),

    // --- SUNUCU İSTEKLERİ (FETCH) ---
    register: async (userData) => {
        const res = await fetch(`${API_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(userData)
        });
        return await res.json();
    },

    login: async (email, password) => {
        const res = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        return await res.json();
    },

    addVehicle: async (vehicleData) => {
        const res = await fetch(`${API_URL}/vehicles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(vehicleData)
        });
        return await res.json();
    },

    getMyVehicles: async (userId) => {
        const res = await fetch(`${API_URL}/vehicles/${userId}`);
        return await res.json();
    },

    deleteVehicle: async (vehicleId) => {
        await fetch(`${API_URL}/vehicles/${vehicleId}`, { method: 'DELETE' });
    },

    createAppointment: async (appData) => {
        const res = await fetch(`${API_URL}/appointments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(appData)
        });
        return await res.json();
    },

    getMyAppointments: async (userId) => {
        const res = await fetch(`${API_URL}/appointments?userId=${userId}`);
        return await res.json();
    },

    cancelAppointment: async (appId) => {
        await fetch(`${API_URL}/appointments/${appId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'Cancelled' })
        });
    }
};

// --- 2. AUTHENTICATION ---
async function handleRegister(e) {
    e.preventDefault();
    const name = document.getElementById('regName').value;
    const email = document.getElementById('regEmail').value;
    const phone = document.getElementById('regPhone').value;
    const password = document.getElementById('regPassword').value;

    try {
        const response = await API.register({ name, email, phone, password });
        if (response.error) {
            showNotification(response.error, "error");
        } else {
            showNotification("Registration successful! Redirecting...", "success");
            setTimeout(() => { window.location.href = 'index.html'; }, 2000);
        }
    } catch (err) {
        showNotification("Server error! Please try again.", "error");
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const emailInput = document.querySelector('#loginForm input[type="email"]');
    const passwordInput = document.querySelector('#loginForm input[type="password"]');
    if(!emailInput || !passwordInput) return;

    try {
        const response = await API.login(emailInput.value, passwordInput.value);
        if (response.success) {
            API.setCurrentUser(response.user);
            if (response.user.email === 'admin@pitstop.com') {
                window.location.href = 'admin.html';
            } else {
                window.location.href = 'dashboard.html';
            }
        } else {
            showNotification(response.message || "Invalid credentials", "error");
        }
    } catch (err) {
        showNotification("Connection failed. Is the server running?", "error");
    }
}

function checkAuthStatus() {
    const user = API.getCurrentUser();
    const path = window.location.pathname;
    const protectedPages = ['dashboard.html', 'appointment.html'];
    
    if (protectedPages.some(page => path.includes(page)) && !user) {
        window.location.href = 'index.html';
        return;
    }
    if (user) {
        document.querySelectorAll('.navbar-text-user').forEach(el => el.textContent = user.name);
    }
}

// --- 3. DASHBOARD & OPERATIONS ---
async function renderUserDashboard() {
    const user = API.getCurrentUser();
    if (!user) return;

    const myVehicles = await API.getMyVehicles(user.id);
    const myAppointments = await API.getMyAppointments(user.id);
    
    const countEl = document.getElementById('totalCarsCount');
    if(countEl) countEl.textContent = myVehicles.length;

    const nextServiceEl = document.getElementById('nextServiceDate');
    if (nextServiceEl) {
        const pendingApps = myAppointments.filter(app => app.status === 'Pending');
        if (pendingApps.length > 0) {
            pendingApps.sort((a,b) => new Date(a.date) - new Date(b.date));
            nextServiceEl.textContent = new Date(pendingApps[0].date).toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
        } else {
            nextServiceEl.textContent = "-";
        }
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
            myVehicles.forEach(v => {
                vContainer.innerHTML += `
                <div class="vehicle-card-wide">
                    <div class="d-flex align-items-center">
                        <div class="v-icon-box"><i class="fa-solid fa-car"></i></div>
                        <div class="v-details"><h4>${v.model}</h4><span class="text-uppercase">${v.brand}</span></div>
                    </div>
                    <div class="d-flex align-items-center gap-4">
                        <div class="v-plate d-none d-md-block">${v.plate}</div>
                        <button class="btn btn-sm text-danger border-0" onclick="window.deleteVehicle(${v.id})"><i class="fa-solid fa-trash-can fa-lg"></i></button>
                    </div>
                </div>`;
            });
        }
    }
    renderAppointmentTimeline(myAppointments);
}

function renderAppointmentTimeline(appointments) {
    const timelineContainer = document.getElementById('appointmentTimeline');
    if (!timelineContainer) return;
    timelineContainer.innerHTML = '';
    
    const activeAppointments = appointments.filter(app => app.status !== 'Cancelled');
    if (activeAppointments.length === 0) {
        timelineContainer.innerHTML = `<div class="text-center text-muted py-4 border border-secondary rounded bg-dark"><p class="m-0">No active appointments.</p></div>`;
        return;
    }
    activeAppointments.sort((a,b) => new Date(b.date) - new Date(a.date));

    let html = '<div class="timeline">';
    activeAppointments.forEach(app => {
        const formattedDate = new Date(app.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        const isPending = app.status === 'Pending';
        const statusColor = isPending ? 'status-pending' : 'status-success';
        const carName = app.car_info || app.car; 
        const serviceName = app.services || app.service;
        const actionBtn = isPending ? `<button class="btn btn-sm btn-outline-danger ms-auto" style="font-size: 0.7rem;" onclick="cancelAppointment(${app.id})">CANCEL</button>` : '';

        html += `
        <div class="timeline-item">
            <div class="timeline-dot"></div>
            <div class="timeline-content">
                <span class="timeline-date"><i class="fa-regular fa-calendar me-2"></i>${formattedDate}</span>
                <div class="d-flex justify-content-between align-items-start mt-1">
                    <div>
                        <h6 class="fw-bold text-white mb-1">${serviceName}</h6>
                        <small class="text-muted d-block mb-2">${carName}</small>
                        <div class="d-flex align-items-center"><span class="status-indicator ${statusColor}"></span><small class="text-white">${app.status}</small></div>
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
    const user = API.getCurrentUser();
    const newVehicle = {
        userId: user.id,
        brand: document.getElementById('newCarBrand').value,
        model: document.getElementById('newCarModel').value,
        plate: document.getElementById('newCarPlate').value
    };
    try {
        await API.addVehicle(newVehicle);
        bootstrap.Modal.getInstance(document.getElementById('addVehicleModal')).hide();
        e.target.reset();
        await renderUserDashboard();
        showNotification("Vehicle added.", "success");
    } catch (err) { showNotification("Error adding vehicle.", "error"); }
}

function deleteVehicle(id) {
    if(confirm('Delete this vehicle?')) {
        API.deleteVehicle(id).then(() => {
            renderUserDashboard();
            showNotification("Vehicle deleted.", "success");
        });
    }
}

async function handleAppointmentSubmit(e) {
    e.preventDefault();
    const user = API.getCurrentUser();
    const carSelect = document.getElementById('carSelect');
    const dateInput = document.getElementById('dateInput');
    const noteInput = document.getElementById('noteInput');
    const selectedCheckboxes = document.querySelectorAll('.service-checkbox:checked');
    
    if (!carSelect.value || !dateInput.value || selectedCheckboxes.length === 0) {
        showNotification("Please fill all fields.", "error");
        return;
    }

    let serviceNames = [];
    let totalPrice = 0;
    selectedCheckboxes.forEach(box => {
        serviceNames.push(box.getAttribute('data-name'));
        totalPrice += parseInt(box.value);
    });

    const newApp = {
        userId: user.id,
        car: carSelect.value,
        service: serviceNames.join(', '),
        price: totalPrice,
        date: dateInput.value,
        note: noteInput ? noteInput.value : ''
    };

    try {
        await API.createAppointment(newApp);
        new bootstrap.Modal(document.getElementById('successModal')).show();
        e.target.reset();
        document.getElementById('priceDisplay').textContent = "0 $";
    } catch (err) { showNotification("Failed to create appointment.", "error"); }
}

function cancelAppointment(id) {
    if(confirm('Cancel appointment?')) {
        API.cancelAppointment(id).then(() => {
            renderUserDashboard();
            showNotification("Appointment canceled.", "success");
        });
    }
}

async function populateCarSelect() {
    const select = document.getElementById('carSelect');
    if (!select) return;
    const user = API.getCurrentUser();
    const myVehicles = await API.getMyVehicles(user.id);
    select.innerHTML = '<option value="" selected disabled>Select...</option>';
    if (myVehicles.length === 0) {
        new bootstrap.Modal(document.getElementById('noCarsModal')).show();
    } else {
        myVehicles.forEach(v => {
            select.innerHTML += `<option value="${v.brand} ${v.model} (${v.plate})">${v.brand} ${v.model} (${v.plate})</option>`;
        });
    }
}

function checkCarsBeforeAppointment(e) { e.preventDefault(); window.location.href = 'appointment.html'; }
function redirectToAddVehicle() { window.location.href = 'dashboard.html'; }

function setupPriceCalculator() {
    const checkboxes = document.querySelectorAll('.service-checkbox');
    const priceDisplay = document.getElementById('priceDisplay');
    checkboxes.forEach(box => {
        box.addEventListener('change', () => {
            let total = 0;
            document.querySelectorAll('.service-checkbox:checked').forEach(c => total += parseInt(c.value));
            priceDisplay.textContent = total + " $";
        });
    });
}

function showNotification(message, type = 'success') {
    const toastEl = document.getElementById('liveToast');
    if (!toastEl) return; 
    document.getElementById('toastMessage').textContent = message;
    const toast = new bootstrap.Toast(toastEl);
    toast.show();
}

function setupEventListeners() {
    const regForm = document.getElementById('registerForm');
    if (regForm) regForm.addEventListener('submit', handleRegister);
    const loginForm = document.getElementById('loginForm');
    if (loginForm) loginForm.addEventListener('submit', handleLogin);
    const addVehForm = document.getElementById('addVehicleForm');
    if (addVehForm) addVehForm.addEventListener('submit', handleAddVehicle);
    if (document.querySelector('.service-checkbox')) { setupPriceCalculator(); }
    const logoutBtn = document.getElementById('logoutBtn');
    if(logoutBtn) logoutBtn.addEventListener('click', (e) => { e.preventDefault(); API.logout(); window.location.href = 'index.html'; });
}

window.deleteVehicle = deleteVehicle;
window.cancelAppointment = cancelAppointment;
window.handleAppointment = handleAppointmentSubmit;
window.checkCarsBeforeAppointment = checkCarsBeforeAppointment;
window.redirectToAddVehicle = redirectToAddVehicle;