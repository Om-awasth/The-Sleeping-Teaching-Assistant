/**
 * Sleeping Teaching Assistant Visualizer — Client Application
 *
 * Implements WebSocket communication, live architectural floor-plan rendering,
 * student avatar state transitions, real-time timeline strip charting,
 * telemetry statistics, and full simulation controls.
 */

(function () {
  'use strict';

  // DOM Elements
  const wsPill = document.getElementById('wsPill');
  const wsText = document.getElementById('wsText');
  const engineIndicator = document.getElementById('engineIndicator');
  const indicatorLabel = document.getElementById('indicatorLabel');
  const simClock = document.getElementById('simClock');

  // Metrics
  const valServed = document.getElementById('valServed');
  const valTurnedAway = document.getElementById('valTurnedAway');
  const valAvgWait = document.getElementById('valAvgWait');
  const valTaBusy = document.getElementById('valTaBusy');
  const valQueueLen = document.getElementById('valQueueLen');
  const valQueueSub = document.getElementById('valQueueSub');

  // Floor Plan Elements
  const arrivalStaging = document.getElementById('arrivalStaging');
  const chairsRow = document.getElementById('chairsRow');
  const visitorChair = document.getElementById('visitorChair');
  const taAvatarWrapper = document.getElementById('taAvatarWrapper');
  const taSpeech = document.getElementById('taSpeech');
  const taStateTag = document.getElementById('taStateTag');

  // Controls
  const inputStudents = document.getElementById('inputStudents');
  const inputChairs = document.getElementById('inputChairs');
  const inputMinHelp = document.getElementById('inputMinHelp');
  const inputMaxHelp = document.getElementById('inputMaxHelp');
  const inputMinArr = document.getElementById('inputMinArr');
  const inputMaxArr = document.getElementById('inputMaxArr');
  const speedSlider = document.getElementById('speedSlider');
  const speedDisplay = document.getElementById('speedDisplay');
  const btnStart = document.getElementById('btnStart');
  const btnPause = document.getElementById('btnPause');
  const btnSpawn = document.getElementById('btnSpawn');
  const btnReset = document.getElementById('btnReset');

  // Logs & Timeline
  const eventFeed = document.getElementById('eventFeed');
  const logCounter = document.getElementById('logCounter');
  const logEmptyState = document.getElementById('logEmptyState');
  const chkAutoScroll = document.getElementById('chkAutoScroll');
  const btnClearLog = document.getElementById('btnClearLog');
  const taTimelineCanvas = document.getElementById('taTimelineCanvas');
  const ctxTimeline = taTimelineCanvas.getContext('2d');

  // Application State
  let ws = null;
  let isRunning = false;
  let isPaused = false;
  let eventCount = 0;
  let numChairsConfig = 3;
  let chairState = []; // Array of student IDs or -1
  let currentTaState = 'sleeping'; // 'sleeping' | 'awake' | 'helping'
  let currentHelpedStudentId = -1;
  let simStartTime = 0;

  // Timeline Buffer: array of { state: 'sleeping'|'awake'|'helping', timestamp: ms }
  const timelineHistory = [];
  const MAX_TIMELINE_POINTS = 300;

  /**
   * Deterministic Color Generator for Student Avatars based on ID
   */
  function getStudentColor(id) {
    const hue = (id * 137.5) % 360; // Golden ratio hue spread
    return `hsl(${hue}, 68%, 44%)`;
  }

  /**
   * Build an SVG Student Avatar Element
   */
  function createStudentAvatar(id, extraClass = '') {
    const color = getStudentColor(id);
    const token = document.createElement('div');
    token.className = `student-token ${extraClass}`;
    token.id = `studentToken_${id}`;

    token.innerHTML = `
      <div class="token-avatar" style="background-color: ${color};">
        S${id}
      </div>
      <div class="token-badge">Student #${id}</div>
    `;
    return token;
  }

  /**
   * WebSocket Connection Management
   */
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    ws = new WebSocket(`${protocol}//${host}`);

    ws.onopen = () => {
      wsPill.classList.remove('disconnected');
      wsText.textContent = 'Connected';
    };

    ws.onclose = () => {
      wsPill.classList.add('disconnected');
      wsText.textContent = 'Reconnecting...';
      setTimeout(connectWebSocket, 1500);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        handleServerEvent(data);
      } catch (err) {
        console.error('Invalid JSON event:', err, msg.data);
      }
    };
  }

  /**
   * Send command to Server
   */
  function sendCommand(action, payload = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action, ...payload }));
    }
  }

  /**
   * Render Waiting Chairs Row
   */
  function renderChairs(count) {
    numChairsConfig = count;
    chairsRow.innerHTML = '';
    chairState = new Array(count).fill(-1);

    if (count === 0) {
      chairsRow.innerHTML = `<div style="font-size:12px; color:#8c8273; font-style:italic;">0 hallway chairs configured. All arriving students will be turned away unless the office is free.</div>`;
      return;
    }

    for (let i = 0; i < count; i++) {
      const slot = document.createElement('div');
      slot.className = 'chair-slot';
      slot.id = `chairSlot_${i}`;
      slot.innerHTML = `
        <span class="chair-num">CHAIR ${i + 1}</span>
        <div class="chair-frame" id="chairFrame_${i}">
          <div class="chair-cushion" id="chairCushion_${i}">
            <span class="chair-empty-label">VACANT</span>
          </div>
        </div>
      `;
      chairsRow.appendChild(slot);
    }
  }

  /**
   * Set TA Visual State
   */
  function setTaState(state, studentId = null) {
    currentTaState = state;
    taAvatarWrapper.className = `ta-avatar-wrapper state-${state}`;

    if (state === 'sleeping') {
      taSpeech.textContent = 'Sleeping... zZz';
      taStateTag.textContent = 'STATUS: SLEEPING';
      taStateTag.style.color = '#64748b';
    } else if (state === 'awake') {
      taSpeech.textContent = 'Awake! Checking queue...';
      taStateTag.textContent = 'STATUS: AWAKE';
      taStateTag.style.color = '#b45309';
    } else if (state === 'helping') {
      taSpeech.textContent = `Consulting with Student #${studentId}`;
      taStateTag.textContent = `HELPING S#${studentId}`;
      taStateTag.style.color = '#15803d';
    }
    recordTimelineSample(state);
  }

  /**
   * Handle Inbound Simulation Events from C Engine via WebSocket
   */
  function handleServerEvent(event) {
    // Session init event from server
    if (event.type === 'session_init') {
      isRunning = event.running;
      isPaused = event.paused;
      updateControlButtons();
      if (event.config) {
        inputStudents.value = event.config.students;
        inputChairs.value = event.config.chairs;
        inputMinHelp.value = event.config.minHelp;
        inputMaxHelp.value = event.config.maxHelp;
        inputMinArr.value = event.config.minArr;
        inputMaxArr.value = event.config.maxArr;
        speedSlider.value = event.config.speed;
        speedDisplay.textContent = `${parseFloat(event.config.speed).toFixed(2)}x`;
        renderChairs(event.config.chairs);
      }
      if (event.history && event.history.length > 0) {
        event.history.forEach((h) => handleSimulationEvent(h, false));
      }
      return;
    }

    if (event.type === 'sim_reset') {
      resetUiState();
      appendLogEntry({ t: 0, type: 'init' }, 'Simulation state reset.');
      return;
    }

    if (event.type === 'sim_stopped') {
      isRunning = false;
      isPaused = false;
      updateControlButtons();
      setTaState('sleeping');
      appendLogEntry({ t: 0, type: 'sim_exit' }, `C process terminated (exit code: ${event.code}).`);
      return;
    }

    handleSimulationEvent(event, true);
  }

  /**
   * Main Dispatcher for Simulation Events
   */
  function handleSimulationEvent(ev, shouldAnimate) {
    if (ev.t !== undefined) {
      simClock.textContent = `T+ ${(ev.t / 1000).toFixed(2)}s`;
    }

    switch (ev.type) {
      case 'init': {
        isRunning = true;
        isPaused = false;
        simStartTime = ev.t || 0;
        updateControlButtons();
        renderChairs(ev.chairs);
        valQueueLen.textContent = `0 / ${ev.chairs}`;
        setTaState('sleeping');
        appendLogEntry(ev, `Initialized simulation: ${ev.students} students, ${ev.chairs} chairs.`);
        break;
      }

      case 'student_arrive': {
        appendLogEntry(ev, `Student #${ev.id} arrived at the TA office hallway.`);
        if (shouldAnimate) {
          const arrivingEl = createStudentAvatar(ev.id, 'arriving');
          arrivalStaging.innerHTML = '';
          arrivalStaging.appendChild(arrivingEl);
          setTimeout(() => {
            if (arrivingEl.parentNode === arrivalStaging) {
              arrivingEl.remove();
            }
          }, 1500);
        }
        break;
      }

      case 'student_sit': {
        const chairIdx = ev.chair;
        chairState[chairIdx] = ev.id;
        const slot = document.getElementById(`chairSlot_${chairIdx}`);
        const cushion = document.getElementById(`chairCushion_${chairIdx}`);

        if (slot && cushion) {
          slot.classList.add('occupied');
          cushion.innerHTML = '';
          cushion.appendChild(createStudentAvatar(ev.id));
        }

        const queueStr = Array.isArray(ev.queue) ? ev.queue.join(', ') : '';
        valQueueLen.textContent = `${ev.queue ? ev.queue.length : '1'} / ${numChairsConfig}`;
        appendLogEntry(ev, `Student #${ev.id} took chair #${chairIdx + 1}. Queue: [${queueStr}]`);
        break;
      }

      case 'student_leave_full': {
        appendLogEntry(ev, `Student #${ev.id} turned away — no waiting chairs free.`);
        if (shouldAnimate) {
          const token = createStudentAvatar(ev.id, 'turned-away');
          const notice = document.createElement('div');
          notice.className = 'turn-away-notice';
          notice.textContent = 'NO CHAIRS FREE';
          token.appendChild(notice);

          arrivalStaging.innerHTML = '';
          arrivalStaging.appendChild(token);
          setTimeout(() => {
            if (token.parentNode === arrivalStaging) {
              token.remove();
            }
          }, 1400);
        }
        break;
      }

      case 'ta_sleep': {
        setTaState('sleeping');
        appendLogEntry(ev, `No students waiting. TA is sleeping.`);
        break;
      }

      case 'ta_wake': {
        setTaState('awake');
        appendLogEntry(ev, `TA woke up to assist waiting student.`);
        break;
      }

      case 'help_start': {
        currentHelpedStudentId = ev.id;
        setTaState('helping', ev.id);

        // Free the chair that the student was occupying
        if (ev.chair !== -1 && ev.chair !== undefined) {
          chairState[ev.chair] = -1;
          const slot = document.getElementById(`chairSlot_${ev.chair}`);
          const cushion = document.getElementById(`chairCushion_${ev.chair}`);
          if (slot && cushion) {
            slot.classList.remove('occupied');
            cushion.innerHTML = `<span class="chair-empty-label">VACANT</span>`;
          }
        }

        // Place student in desk visitor seat
        visitorChair.classList.add('occupied');
        visitorChair.innerHTML = '';
        visitorChair.appendChild(createStudentAvatar(ev.id));

        if (ev.queue) {
          valQueueLen.textContent = `${ev.queue.length} / ${numChairsConfig}`;
        }

        appendLogEntry(ev, `TA began consultation with Student #${ev.id} (duration: ${ev.duration}ms).`);
        break;
      }

      case 'help_end': {
        // Free visitor chair
        visitorChair.classList.remove('occupied');
        visitorChair.innerHTML = `<div class="chair-silhouette"></div>`;

        appendLogEntry(ev, `Finished consultation with Student #${ev.id}. Student left office.`);
        currentHelpedStudentId = -1;
        break;
      }

      case 'stats': {
        valServed.textContent = ev.served ?? 0;
        valTurnedAway.textContent = ev.turned_away ?? 0;
        valAvgWait.innerHTML = `${ev.avg_wait ?? 0}<span class="metric-unit">ms</span>`;
        valTaBusy.innerHTML = `${ev.ta_busy_pct ?? 0}<span class="metric-unit">%</span>`;
        if (ev.queue_len !== undefined) {
          valQueueLen.textContent = `${ev.queue_len} / ${numChairsConfig}`;
        }
        break;
      }

      case 'speed_change': {
        speedSlider.value = ev.speed;
        speedDisplay.textContent = `${parseFloat(ev.speed).toFixed(2)}x`;
        appendLogEntry(ev, `Simulation speed set to ${parseFloat(ev.speed).toFixed(2)}x.`);
        break;
      }

      case 'sim_paused': {
        isPaused = true;
        updateControlButtons();
        appendLogEntry(ev, `Simulation execution paused.`);
        break;
      }

      case 'sim_resumed': {
        isPaused = false;
        updateControlButtons();
        appendLogEntry(ev, `Simulation execution resumed.`);
        break;
      }

      case 'student_spawned': {
        appendLogEntry(ev, `Spawned extra Student #${ev.id} (Total: ${ev.total_students}).`);
        break;
      }

      case 'sim_exit': {
        isRunning = false;
        isPaused = false;
        updateControlButtons();
        setTaState('sleeping');
        appendLogEntry(ev, `Simulation stopped.`);
        break;
      }

      default:
        break;
    }
  }

  /**
   * Append formatted entry to live event feed
   */
  function appendLogEntry(ev, description) {
    if (logEmptyState && logEmptyState.parentNode) {
      logEmptyState.remove();
    }

    eventCount++;
    logCounter.textContent = `${eventCount} events`;

    const entry = document.createElement('div');
    const badgeClass = getBadgeClass(ev.type);
    const badgeLabel = getBadgeLabel(ev.type);
    const timeStr = `+${((ev.t || 0) / 1000).toFixed(2)}s`;

    entry.className = `log-entry ${badgeClass}`;
    entry.innerHTML = `
      <span class="log-time">${timeStr}</span>
      <span class="log-badge">${badgeLabel}</span>
      <span class="log-desc">${description}</span>
    `;

    eventFeed.appendChild(entry);

    if (chkAutoScroll.checked) {
      eventFeed.scrollTop = eventFeed.scrollHeight;
    }
  }

  function getBadgeClass(type) {
    switch (type) {
      case 'init': return 'event-init';
      case 'student_arrive': return 'event-arrive';
      case 'student_sit': return 'event-sit';
      case 'student_leave_full': return 'event-leave-full';
      case 'ta_sleep': return 'event-sleep';
      case 'ta_wake': return 'event-wake';
      case 'help_start': return 'event-help-start';
      case 'help_end': return 'event-help-end';
      case 'stats': return 'event-stats';
      case 'student_spawned': return 'event-spawn';
      default: return 'event-init';
    }
  }

  function getBadgeLabel(type) {
    switch (type) {
      case 'init': return 'INIT';
      case 'student_arrive': return 'ARRIVE';
      case 'student_sit': return 'SIT';
      case 'student_leave_full': return 'NO CHAIR';
      case 'ta_sleep': return 'TA SLEEP';
      case 'ta_wake': return 'TA WAKE';
      case 'help_start': return 'HELP START';
      case 'help_end': return 'HELP END';
      case 'stats': return 'TELEMETRY';
      case 'student_spawned': return 'SPAWN';
      case 'sim_paused': return 'PAUSE';
      case 'sim_resumed': return 'RESUME';
      case 'sim_exit': return 'EXIT';
      default: return type.toUpperCase();
    }
  }

  /**
   * Record Timeline Sample for the Canvas Chart
   */
  function recordTimelineSample(state) {
    timelineHistory.push({
      state,
      time: Date.now()
    });
    if (timelineHistory.length > MAX_TIMELINE_POINTS) {
      timelineHistory.shift();
    }
  }

  /**
   * Animate & Render Timeline Strip Chart
   */
  function drawTimeline() {
    const width = taTimelineCanvas.width;
    const height = taTimelineCanvas.height;

    ctxTimeline.clearRect(0, 0, width, height);

    // Subtle background guidelines
    ctxTimeline.strokeStyle = '#ede6da';
    ctxTimeline.lineWidth = 1;
    ctxTimeline.beginPath();
    ctxTimeline.moveTo(0, height * 0.33);
    ctxTimeline.lineTo(width, height * 0.33);
    ctxTimeline.moveTo(0, height * 0.66);
    ctxTimeline.lineTo(width, height * 0.66);
    ctxTimeline.stroke();

    if (timelineHistory.length < 2) {
      requestAnimationFrame(drawTimeline);
      return;
    }

    const step = width / (MAX_TIMELINE_POINTS - 1);
    const startX = width - (timelineHistory.length * step);

    for (let i = 0; i < timelineHistory.length; i++) {
      const item = timelineHistory[i];
      const x = startX + (i * step);

      let barColor = '#64748b'; // Sleeping
      let barHeight = height * 0.35;
      let barY = height - barHeight;

      if (item.state === 'awake') {
        barColor = '#f59e0b';
        barHeight = height * 0.65;
        barY = height - barHeight;
      } else if (item.state === 'helping') {
        barColor = '#15803d';
        barHeight = height * 0.95;
        barY = height - barHeight;
      }

      ctxTimeline.fillStyle = barColor;
      ctxTimeline.fillRect(x, barY, Math.ceil(step) + 1, barHeight);
    }

    requestAnimationFrame(drawTimeline);
  }

  /**
   * Heartbeat to keep timeline rolling even if no new state events
   */
  setInterval(() => {
    if (isRunning && !isPaused) {
      recordTimelineSample(currentTaState);
    }
  }, 200);

  /**
   * Update Control Button States & Badges
   */
  function updateControlButtons() {
    if (isRunning) {
      engineIndicator.className = isPaused ? 'engine-indicator paused' : 'engine-indicator running';
      indicatorLabel.textContent = isPaused ? 'Paused' : 'Running (POSIX)';
      btnStart.disabled = true;
      btnPause.disabled = false;
      btnSpawn.disabled = false;
      btnPause.innerHTML = isPaused ? `<span class="btn-icon">&#9658;</span> Resume` : `<span class="btn-icon">&#10074;&#10074;</span> Pause`;
    } else {
      engineIndicator.className = 'engine-indicator';
      indicatorLabel.textContent = 'Engine Idle';
      btnStart.disabled = false;
      btnPause.disabled = true;
      btnSpawn.disabled = true;
      btnPause.innerHTML = `<span class="btn-icon">&#10074;&#10074;</span> Pause`;
    }
  }

  /**
   * Reset UI State
   */
  function resetUiState() {
    isRunning = false;
    isPaused = false;
    currentHelpedStudentId = -1;
    updateControlButtons();
    setTaState('sleeping');

    valServed.textContent = '0';
    valTurnedAway.textContent = '0';
    valAvgWait.innerHTML = `0<span class="metric-unit">ms</span>`;
    valTaBusy.innerHTML = `0<span class="metric-unit">%</span>`;
    valQueueLen.textContent = `0 / ${numChairsConfig}`;
    simClock.textContent = 'T+ 0.00s';

    visitorChair.classList.remove('occupied');
    visitorChair.innerHTML = `<div class="chair-silhouette"></div>`;
    renderChairs(parseInt(inputChairs.value, 10));
    arrivalStaging.innerHTML = '';
  }

  /**
   * User Action Event Listeners
   */
  btnStart.addEventListener('click', () => {
    const config = {
      students: parseInt(inputStudents.value, 10),
      chairs: parseInt(inputChairs.value, 10),
      minHelp: parseInt(inputMinHelp.value, 10),
      maxHelp: parseInt(inputMaxHelp.value, 10),
      minArr: parseInt(inputMinArr.value, 10),
      maxArr: parseInt(inputMaxArr.value, 10),
      speed: parseFloat(speedSlider.value)
    };
    resetUiState();
    sendCommand('start', config);
  });

  btnPause.addEventListener('click', () => {
    if (isPaused) {
      sendCommand('resume');
    } else {
      sendCommand('pause');
    }
  });

  btnSpawn.addEventListener('click', () => {
    sendCommand('spawn');
  });

  btnReset.addEventListener('click', () => {
    sendCommand('reset');
  });

  speedSlider.addEventListener('input', (e) => {
    const speed = parseFloat(e.target.value);
    speedDisplay.textContent = `${speed.toFixed(2)}x`;
    sendCommand('speed', { speed });
  });

  btnClearLog.addEventListener('click', () => {
    eventFeed.innerHTML = '';
    eventCount = 0;
    logCounter.textContent = '0 events';
  });

  // Initial Setup
  renderChairs(3);
  connectWebSocket();
  drawTimeline();

})();

