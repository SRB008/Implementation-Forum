const VALID_TYPES = ['Release', 'Delivery', 'CRO', 'Data', 'Cyber', 'Operations', 'D365'];
const TYPE_COLORS = {
  Release: '#4fce65',
  Delivery: '#5b8cff',
  CRO: '#dc60c3',
  Data: '#ffd505',
  Cyber: '#ff8b3e',
  Operations: '#ff4853',
  D365: '#9aa0a6',
};
const VALID_SPRINTS = [0, 1];
const CSV_HEADER = 'id,sprint,title,type';
const DB_NAME = 'kanban-db';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'tasksFile';

const supportsFS = typeof window.showOpenFilePicker === 'function';

let tasks = [];
let fileHandle = null;
let draggedCardId = null;

// ---- CSV helpers ----

function escapeCsvField(value) {
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line) => {
    const [id, sprint, title, type] = parseCsvLine(line);
    return { id, sprint: Number(sprint), title, type };
  });
}

function tasksToCsv(list) {
  const lines = [CSV_HEADER];
  for (const t of list) {
    lines.push([t.id, t.sprint, escapeCsvField(t.title), escapeCsvField(t.type)].join(','));
  }
  return lines.join('\n') + '\n';
}

function nextId(list) {
  const max = list.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
  return String(max + 1);
}

// ---- validation ----

function validateTask({ title, type, sprint }) {
  const errors = [];
  if (typeof title !== 'string' || title.trim().length === 0) errors.push('title is required');
  if (!VALID_TYPES.includes(type)) errors.push(`type must be one of: ${VALID_TYPES.join(', ')}`);
  if (!VALID_SPRINTS.includes(Number(sprint))) errors.push('sprint must be 0 (Next) or 1 (Next+1)');
  return errors;
}

// ---- IndexedDB handle persistence ----

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- DOM references ----

const cardLists = {
  0: document.querySelector('.card-list[data-sprint="0"]'),
  1: document.querySelector('.card-list[data-sprint="1"]'),
};

const fileStatus = document.getElementById('file-status');
const openFileBtn = document.getElementById('open-file-btn');
const newFileBtn = document.getElementById('new-file-btn');
const importInput = document.getElementById('import-input');
const importLabel = document.getElementById('import-label');
const exportBtn = document.getElementById('export-btn');
const exportPngBtn = document.getElementById('export-png-btn');
const addTaskBtn = document.getElementById('add-task-btn');
const fallbackNotice = document.getElementById('fallback-notice');

const modalBackdrop = document.getElementById('modal-backdrop');
const taskForm = document.getElementById('task-form');
const modalTitle = document.getElementById('modal-title');
const taskIdInput = document.getElementById('task-id');
const taskTitleInput = document.getElementById('task-title');
const taskTypeSelect = document.getElementById('task-type');
const taskSprintSelect = document.getElementById('task-sprint');
const deleteBtn = document.getElementById('delete-task-btn');

taskTypeSelect.innerHTML = VALID_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('');

// ---- mode setup ----

if (!supportsFS) {
  fallbackNotice.classList.remove('hidden');
  openFileBtn.classList.add('hidden');
  newFileBtn.classList.add('hidden');
  exportBtn.classList.remove('hidden');
} else {
  importLabel.classList.add('hidden');
}

// ---- file connection (File System Access API) ----

async function verifyPermission(handle, mode = 'readwrite') {
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

async function connectHandle(handle, isNew) {
  if (!(await verifyPermission(handle))) {
    setFileStatus('Permission denied', false);
    return;
  }
  fileHandle = handle;
  await idbSet(HANDLE_KEY, handle);

  if (isNew) {
    tasks = [];
    await persist();
  } else {
    const file = await fileHandle.getFile();
    const text = await file.text();
    tasks = parseCsv(text);
  }

  setFileStatus(fileHandle.name, true);
  addTaskBtn.disabled = false;
  render();
}

function setFileStatus(name, connected) {
  fileStatus.textContent = connected ? `Connected: ${name}` : name;
}

openFileBtn.addEventListener('click', async () => {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }],
    });
    await connectHandle(handle, false);
  } catch (err) {
    if (err.name !== 'AbortError') console.error(err);
  }
});

newFileBtn.addEventListener('click', async () => {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: 'tasks.csv',
      types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }],
    });
    await connectHandle(handle, true);
  } catch (err) {
    if (err.name !== 'AbortError') console.error(err);
  }
});

async function tryReconnectStoredHandle() {
  if (!supportsFS) return;
  try {
    const handle = await idbGet(HANDLE_KEY);
    if (!handle) return;
    if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      setFileStatus(`${handle.name} (click Open tasks.csv to reconnect)`, false);
      return;
    }
    const file = await handle.getFile();
    const text = await file.text();
    fileHandle = handle;
    tasks = parseCsv(text);
    setFileStatus(handle.name, true);
    addTaskBtn.disabled = false;
    render();
  } catch (err) {
    console.error(err);
  }
}

// ---- fallback (import/export) mode ----

importInput.addEventListener('change', async () => {
  const file = importInput.files[0];
  if (!file) return;
  const text = await file.text();
  tasks = parseCsv(text);
  setFileStatus(`Imported: ${file.name}`, true);
  addTaskBtn.disabled = false;
  render();
  importInput.value = '';
});

exportBtn.addEventListener('click', () => {
  const blob = new Blob([tasksToCsv(tasks)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tasks.csv';
  a.click();
  URL.revokeObjectURL(url);
});

// ---- persistence ----

async function persist() {
  if (supportsFS && fileHandle) {
    const writable = await fileHandle.createWritable();
    await writable.write(tasksToCsv(tasks));
    await writable.close();
  }
  // In fallback mode, persistence happens via the explicit "Download CSV" button.
}

// ---- rendering ----

function render() {
  cardLists[0].innerHTML = '';
  cardLists[1].innerHTML = '';

  const bySprint = { 0: [], 1: [] };
  for (const task of tasks) {
    if (bySprint[task.sprint]) bySprint[task.sprint].push(task);
  }

  for (const sprint of [0, 1]) {
    const list = cardLists[sprint];
    if (bySprint[sprint].length === 0) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = 'No tasks';
      list.appendChild(hint);
      continue;
    }

    for (const type of VALID_TYPES) {
      const group = bySprint[sprint]
        .filter((t) => t.type === type)
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
      if (group.length === 0) continue;

      const header = document.createElement('div');
      header.className = 'group-header';
      header.style.setProperty('--type-color', TYPE_COLORS[type]);

      const dot = document.createElement('span');
      dot.className = 'group-header-dot';

      header.appendChild(dot);
      header.appendChild(document.createTextNode(type));
      list.appendChild(header);

      for (const task of group) {
        list.appendChild(renderCard(task));
      }
    }
  }
}

function renderCard(task) {
  const card = document.createElement('div');
  card.className = 'card';
  card.draggable = true;
  card.dataset.id = task.id;
  card.style.setProperty('--type-color', TYPE_COLORS[task.type]);

  const title = document.createElement('p');
  title.className = 'card-title';
  title.textContent = task.title;

  card.appendChild(title);

  card.addEventListener('click', () => openEditModal(task));

  card.addEventListener('dragstart', () => {
    draggedCardId = task.id;
    card.classList.add('dragging');
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    draggedCardId = null;
  });

  return card;
}

for (const sprint of [0, 1]) {
  const list = cardLists[sprint];

  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    list.classList.add('drag-over');
  });

  list.addEventListener('dragleave', () => {
    list.classList.remove('drag-over');
  });

  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    list.classList.remove('drag-over');
    if (draggedCardId === null) return;
    const task = tasks.find((t) => t.id === draggedCardId);
    if (task) {
      task.sprint = sprint;
      await persist();
      render();
    }
  });
}

// ---- PNG export ----

function copyComputedStyle(source, target) {
  const computed = getComputedStyle(source);
  let cssText = '';
  for (let i = 0; i < computed.length; i++) {
    const prop = computed[i];
    cssText += `${prop}:${computed.getPropertyValue(prop)};`;
  }
  target.style.cssText = cssText;
}

function cloneWithComputedStyles(node) {
  const clone = node.cloneNode(false);
  if (node.nodeType === Node.ELEMENT_NODE) {
    copyComputedStyle(node, clone);
  }
  for (const child of node.childNodes) {
    clone.appendChild(cloneWithComputedStyles(child));
  }
  return clone;
}

async function exportBoardAsPng() {
  const board = document.getElementById('board');
  const rect = board.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  const bg = getComputedStyle(document.body).backgroundColor;

  const clonedBoard = cloneWithComputedStyles(board);
  clonedBoard.style.margin = '0';

  const svgMarkup =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;background:${bg};">` +
    clonedBoard.outerHTML +
    `</div></foreignObject></svg>`;

  const svgDataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgMarkup);

  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Failed to rasterize board'));
      img.src = svgDataUrl;
    });

    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = bg || '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'kanban-board.png';
      a.click();
      URL.revokeObjectURL(a.href);
    }, 'image/png');
  } catch (err) {
    console.error(err);
    alert('Could not export board to PNG.');
  }
}

exportPngBtn.addEventListener('click', exportBoardAsPng);

// ---- modal ----

function openAddModal(defaultSprint = 0) {
  modalTitle.textContent = 'Add Task';
  taskIdInput.value = '';
  taskTitleInput.value = '';
  taskTypeSelect.selectedIndex = 0;
  taskSprintSelect.value = String(defaultSprint);
  deleteBtn.classList.add('hidden');
  modalBackdrop.classList.remove('hidden');
  taskTitleInput.focus();
}

function openEditModal(task) {
  modalTitle.textContent = 'Edit Task';
  taskIdInput.value = task.id;
  taskTitleInput.value = task.title;
  taskTypeSelect.value = task.type;
  taskSprintSelect.value = String(task.sprint);
  deleteBtn.classList.remove('hidden');
  modalBackdrop.classList.remove('hidden');
  taskTitleInput.focus();
}

function closeModal() {
  modalBackdrop.classList.add('hidden');
}

addTaskBtn.addEventListener('click', () => openAddModal());
document.getElementById('cancel-btn').addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', (e) => {
  if (e.target === modalBackdrop) closeModal();
});

taskForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = taskIdInput.value;
  const payload = {
    title: taskTitleInput.value.trim(),
    type: taskTypeSelect.value,
    sprint: Number(taskSprintSelect.value),
  };

  const errors = validateTask(payload);
  if (errors.length) {
    alert(errors.join('\n'));
    return;
  }

  if (id) {
    const task = tasks.find((t) => t.id === id);
    Object.assign(task, payload);
  } else {
    tasks.push({ id: nextId(tasks), ...payload });
  }

  await persist();
  closeModal();
  render();
});

deleteBtn.addEventListener('click', async () => {
  const id = taskIdInput.value;
  if (!id) return;
  tasks = tasks.filter((t) => t.id !== id);
  await persist();
  closeModal();
  render();
});

// ---- init ----

tryReconnectStoredHandle();
