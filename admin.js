// Admin console. Uses API, esc(), formatTRY(), formatDate() and STATUS_LABELS from main.js (loaded first).
// Branch admins see their own branch; the HQ admin sees all branches (the API enforces this).
let isShowingCompleted = false;

document.addEventListener('DOMContentLoaded', async function() {
    const user = await API.me();
    if (!user || user.role !== 'admin') {
        alert("ACCESS DENIED: Admins only.");
        window.location.href = 'index.html';
        return;
    }
    const scopeLabel = document.getElementById('adminScopeLabel');
    if (scopeLabel) scopeLabel.textContent = user.branch ? `${user.name} · ${user.branch.name}` : `${user.name} · All branches`;

    renderAdminDashboard();

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

    document.getElementById('adminTableBody').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="set-status"]');
        if (btn) updateStatus(btn.dataset.id, btn.dataset.status);
    });
});

async function renderAdminDashboard() {
    const tableBody = document.getElementById('adminTableBody');
    try {
        const [stats, appointments] = await Promise.all([
            apiFetch('/admin/stats'),
            API.getAppointments(isShowingCompleted ? 'history' : 'active', 200)
        ]);

        document.getElementById('statTotal').innerText = stats.appointments_total.toLocaleString('tr-TR');
        document.getElementById('statPending').innerText = stats.appointments_pending.toLocaleString('tr-TR');
        document.getElementById('statCompleted').innerText = stats.appointments_completed.toLocaleString('tr-TR');
        document.getElementById('statRevenue').innerText = formatTRY(stats.revenue_30d_try);

        if (appointments.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-muted">No records found.</td></tr>`;
            return;
        }

        tableBody.innerHTML = appointments.map(app => {
            let badgeClass = 'bg-secondary';
            if (app.status === 'pending') badgeClass = 'bg-warning text-dark';
            if (app.status === 'confirmed') badgeClass = 'bg-primary';
            if (app.status === 'completed') badgeClass = 'bg-success';
            if (app.status === 'cancelled') badgeClass = 'bg-danger';
            const amount = app.amount_try === null ? '-' : formatTRY(app.amount_try);
            return `
                <tr>
                    <td class="text-white">${esc(formatDate(app.scheduled_for, true))}</td>
                    <td><div class="customer-name-highlight">${esc(app.customer.name)}</div><small class="text-muted">${esc(app.branch.name)} · ${esc(app.channel)}</small></td>
                    <td>${esc(`${app.vehicle.brand} ${app.vehicle.model}`)}<br><small class="text-muted">${esc(app.vehicle.plate)}</small></td>
                    <td><small>${esc(app.services || '-')}</small></td>
                    <td class="text-warning fw-bold">${esc(amount)}</td>
                    <td><small>${esc(app.note || '-')}</small></td>
                    <td><span class="badge ${badgeClass} badge-status">${esc(STATUS_LABELS[app.status] || app.status)}</span></td>
                    <td class="text-end">${getActionButtons(app.id, app.status)}</td>
                </tr>`;
        }).join('');
    } catch (err) {
        console.error(err);
        if (err.status === 401 || err.status === 403) { window.location.href = 'index.html'; return; }
        tableBody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-muted">${esc(err.message)}</td></tr>`;
    }
}

function statusButton(id, status, cls, content) {
    return `<button class="btn btn-sm ${cls}" data-action="set-status" data-id="${esc(id)}" data-status="${status}">${content}</button>`;
}

function getActionButtons(id, status) {
    if (status === 'pending') {
        return statusButton(id, 'confirmed', 'btn-outline-success', '<i class="fa-solid fa-check"></i>') + ' ' +
               statusButton(id, 'cancelled', 'btn-outline-danger', '<i class="fa-solid fa-xmark"></i>');
    } else if (status === 'confirmed') {
        return statusButton(id, 'completed', 'btn-success', 'Finish') + ' ' +
               statusButton(id, 'no_show', 'btn-outline-secondary', 'No-show') + ' ' +
               statusButton(id, 'cancelled', 'btn-outline-danger', '<i class="fa-solid fa-xmark"></i>');
    }
    return '-';
}

async function updateStatus(id, newStatus) {
    if (!confirm(`Change status to ${STATUS_LABELS[newStatus] || newStatus}?`)) return;
    try {
        await API.setAppointmentStatus(id, newStatus);
    } catch (err) {
        showNotification(err.message, "error");
    }
    renderAdminDashboard();
}
