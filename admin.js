//const API_URL = 'http://localhost:3000/api';
let isShowingCompleted = false;

document.addEventListener('DOMContentLoaded', function() {
    const user = JSON.parse(localStorage.getItem('currentUser'));
    if (!user || user.email !== 'admin@pitstop.com') {
        alert("ACCESS DENIED: Admins only.");
        window.location.href = 'index.html';
        return;
    }
    renderAdminDashboard();
    
    document.getElementById('logoutBtn').addEventListener('click', () => {
        localStorage.removeItem('currentUser');
        window.location.href = 'index.html';
    });

    const toggleBtn = document.getElementById('toggleViewBtn');
    toggleBtn.addEventListener('click', function() {
        isShowingCompleted = !isShowingCompleted;
        const tableTitle = document.getElementById('tableTitle');
        if (isShowingCompleted) {
            toggleBtn.innerHTML = 'BACK TO ACTIVE LIST';
            tableTitle.innerHTML = 'COMPLETED JOBS ARCHIVE';
        } else {
            toggleBtn.innerHTML = 'VIEW COMPLETED JOBS';
            tableTitle.innerHTML = 'ACTIVE REQUESTS';
        }
        renderAdminDashboard();
    });
});

async function renderAdminDashboard() {
    try {
        const [appointmentsRes, usersRes] = await Promise.all([
            fetch(`${API_URL}/appointments`),
            fetch(`${API_URL}/users`)
        ]);
        
        const appointments = await appointmentsRes.json();
        const users = await usersRes.json();
        const tableBody = document.getElementById('adminTableBody');
        
        // Stats
        let pendingCount = 0;
        let completedCount = 0;
        let totalRevenue = 0;
        appointments.forEach(app => {
            if (app.status === 'Pending') pendingCount++;
            if (app.status === 'Completed') {
                completedCount++;
                totalRevenue += parseFloat(app.price || 0);
            }
        });

        document.getElementById('statTotal').innerText = appointments.length;
        document.getElementById('statPending').innerText = pendingCount;
        document.getElementById('statCompleted').innerText = completedCount;
        document.getElementById('statRevenue').innerText = totalRevenue.toLocaleString() + ' $';

        tableBody.innerHTML = '';
        appointments.sort((a, b) => new Date(b.date) - new Date(a.date));

        let filteredList = isShowingCompleted ? 
            appointments.filter(app => app.status === 'Completed') : 
            appointments.filter(app => app.status !== 'Completed');

        if (filteredList.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-muted">No records found.</td></tr>`;
            return;
        }

        filteredList.forEach(app => {
            const customer = users.find(u => u.id === app.user_id);
            const customerName = customer ? customer.name : 'Unknown User';
            const carInfo = app.car_info || app.car;
            const services = app.services || app.service;

            let badgeClass = 'bg-secondary';
            if (app.status === 'Pending') badgeClass = 'bg-warning text-dark';
            if (app.status === 'Approved') badgeClass = 'bg-primary';
            if (app.status === 'Completed') badgeClass = 'bg-success';
            if (app.status === 'Cancelled') badgeClass = 'bg-danger';

            const row = `
                <tr>
                    <td class="text-white">${new Date(app.date).toLocaleDateString()}</td>
                    <td><div class="customer-name-highlight">${customerName}</div><small class="text-muted">ID: ${app.user_id}</small></td>
                    <td>${carInfo}</td>
                    <td><small>${services}</small></td>
                    <td class="text-warning fw-bold">${app.price} $</td>
                    <td><small>${app.note || '-'}</small></td>
                    <td><span class="badge ${badgeClass} badge-status">${app.status}</span></td>
                    <td class="text-end">${getActionButtons(app.id, app.status)}</td>
                </tr>`;
            tableBody.innerHTML += row;
        });

    } catch (err) { console.error(err); }
}

function getActionButtons(id, status) {
    if (status === 'Pending') {
        return `<button class="btn btn-sm btn-outline-success" onclick="updateStatus(${id}, 'Approved')"><i class="fa-solid fa-check"></i></button>
                <button class="btn btn-sm btn-outline-danger" onclick="updateStatus(${id}, 'Cancelled')"><i class="fa-solid fa-xmark"></i></button>`;
    } else if (status === 'Approved') {
        return `<button class="btn btn-sm btn-success" onclick="updateStatus(${id}, 'Completed')">Finish</button>`;
    } else if (status === 'Cancelled' || status === 'Completed') {
        return `<button class="btn btn-sm btn-outline-danger border-0" onclick="deleteAppointment(${id})"><i class="fa-solid fa-trash-can"></i></button>`;
    }
    return '-';
}

window.updateStatus = async function(id, newStatus) {
    if(!confirm(`Change status to ${newStatus}?`)) return;
    await fetch(`${API_URL}/appointments/${id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
    });
    renderAdminDashboard();
};

window.deleteAppointment = async function(id) {
    if(!confirm(`Delete permanently?`)) return;
    await fetch(`${API_URL}/appointments/${id}`, { method: 'DELETE' });
    renderAdminDashboard();
};