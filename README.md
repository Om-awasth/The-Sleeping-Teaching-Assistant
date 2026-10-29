# The Sleeping Teaching Assistant (STA) Problem

A complete, production-grade operating systems project simulating the classic **Sleeping Teaching Assistant Problem** (Silberschatz, Galvin, Gagne) using real **POSIX threads**, **semaphores**, and **mutexes** in C, coupled with a **Node.js** bridge and a high-end, responsive architectural web application.

---

## Project Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Web Browser (Frontend)                   │
│   • Architectural Floor Plan (Door, Chairs, TA Office)       │
│   • Real-time Visual Avatars (Sleeping / Awake / Helping)    │
│   • Live Telemetry, Activity Strip Chart & POSIX Event Log   │
└──────────────────────────────▲──────────────────────────────┘
                               │ WebSocket (JSON events & commands)
┌──────────────────────────────▼──────────────────────────────┐
│                    Node.js Server (server.js)               │
│   • Express static file server (/public)                    │
│   • WebSocket server (ws)                                   │
│   • Child process management & auto-compilation via Makefile│
└──────────────────────────────▲──────────────────────────────┘
                               │ Stdin / Stdout (Line-delimited JSON)
┌──────────────────────────────▼──────────────────────────────┐
│                  C Engine Binary (sta)                      │
│   • 1 TA Thread + N Student Threads                         │
│   • POSIX Semaphores: students_sem, ta_sem, ta_done_sem      │
│   • POSIX Mutex: chair_mutex + Condition Variables          │
│   • Strict FIFO Arrival Queue, Deadlock-Free Execution       │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. Project Directory Structure

```
.
├── Makefile             # C compilation recipe (-pthread -Wall -Wextra -O2)
├── sta.c                # Core POSIX C simulation engine
├── package.json         # Node.js dependencies and run scripts
├── server.js            # Express & WebSocket bridge managing C child process
├── public/
│   ├── index.html       # Architectural room layout and UI controls
│   ├── style.css        # Warm editorial / academic workshop design system
│   └── app.js           # WebSocket client, canvas timeline, and avatar state machine
└── README.md            # Documentation, synchronization proofs, and test checklist
```

---

## 2. Prerequisites & Setup

### A. macOS & Linux
Ensure you have **Node.js** (v16+) and a C compiler (**gcc** or **clang** with `make`) installed:

```bash
# Clone or navigate to the project directory
cd "Operating System Project"

# 1. Install Node.js dependencies
npm install

# 2. Compile the C simulation engine
make

# 3. Start the application
npm start
```

Open your browser to: **`http://localhost:3000`**

### B. Windows (via WSL - Recommended)
Since native Windows does not provide standard POSIX `pthread` and `<semaphore.h>` libraries, use the Windows Subsystem for Linux (WSL):

```bash
# 1. Open WSL terminal (Ubuntu)
wsl

# 2. Install GCC and Node.js (if not already installed)
sudo apt update
sudo apt install build-essential nodejs npm

# 3. Navigate to the project directory and run
cd /path/to/project
npm install
make
npm start
```

---

## 3. Concurrency & Synchronization Design

### Problem Specification
- **1 Teaching Assistant (TA)** conducts office hours in an office with 1 consultation seat.
- **C Waiting Chairs** line the hallway outside the office.
- **N Student threads** alternate between independent programming/thinking and seeking help.
- If no students are waiting in the hallway chairs, the TA falls asleep.
- When a student arrives:
  1. If a chair is free, they sit down, join the FIFO waiting queue, and signal the TA (`students_sem`).
  2. If all hallway chairs are occupied, the student cannot wait, leaves immediately (*turned away*), and returns after additional programming.
- When the TA is ready, the student at the head of the queue is invited into the office (`ta_sem`), vacates their hallway chair (making room for newly arriving students), and enters consultation.
- When consultation finishes, the student departs, and the TA checks the hallway queue; if empty, the TA returns to sleep.

### Synchronization Primitives

| Primitive | Type | Initial Value | Purpose |
| :--- | :--- | :--- | :--- |
| `students_sem` | POSIX Semaphore | `0` | Counting semaphore tracking students currently waiting in hallway chairs. TA sleeps on `sem_wait(&students_sem)`. |
| `ta_sem` | POSIX Semaphore | `0` | Rendezvous semaphore. Posted by TA when ready to accept the front student into the consultation office. |
| `ta_done_sem` | POSIX Semaphore | `0` | Signals completion of the consultation session between TA and the student. |
| `chair_mutex` | `pthread_mutex_t` | Unlocked | Protects shared memory: the circular FIFO queue, `chairs` array, `chairs_occupied` counter, and telemetry stats. |
| `student_called_cv`| `pthread_cond_t` | — | Condition variable under `chair_mutex` ensuring only the student designated at the head of the FIFO queue claims `ta_sem`. |
| `ctrl_mutex` + `ctrl_cv`| Mutex + Condvar | — | Coordinates non-blocking pause/resume, responsive speed changes, and graceful thread shutdown. |

### Strict FIFO Fairness
Standard POSIX semaphores wake waiting threads based on OS scheduling policy and do not guarantee FIFO arrival ordering. To guarantee exact arrival-order fairness:
1. Arriving students enqueue their `id` into a circular array queue under `chair_mutex`.
2. Waiting students sleep on `pthread_cond_wait(&student_called_cv, &chair_mutex)`.
3. The TA dequeues the front student (`id = dequeue()`), sets `current_helped_student = id`, broadcasts `student_called_cv`, and posts `ta_sem`.
4. Only student `id` wakes to consume `ta_sem`, guaranteeing 100% strict FIFO fairness without thread starvation or livelock.

### Deadlock & Race-Condition Proof
- **No Hold-and-Wait on Blocking Calls**: `chair_mutex` is never held when calling `sem_wait()`. It is locked exclusively for O(1) state transitions (queueing, chair occupancy checks, metric tallying) and immediately released.
- **Uniform Lock Acquisition**: Mutexes (`chair_mutex`, `ctrl_mutex`, `io_mutex`) are always acquired independently, preventing cyclic lock inversion.
- **Atomicity**: The check for available chairs (`chairs_occupied < num_chairs`), chair assignment, and queue insertion occur atomically inside a single critical section protected by `chair_mutex`. Two arriving students can never claim the same chair.
- **Clean Shutdown**: On `QUIT` or process termination, all condition variables are broadcast and all semaphores are posted, ensuring every thread unblocks, joins cleanly, and destroys all IPC resources without zombie threads or resource leaks.

---

## 4. Verification & Testing Checklist

Follow this checklist to verify that the implementation meets all requirements:

| Test Case | Procedure | Expected Behavior | Status |
| :--- | :--- | :--- | :--- |
| **1. Zero-Warning Build** | Run `make clean && make` | Compiles with `gcc -pthread -Wall -Wextra -O2` with 0 warnings on Linux/macOS. | Verified |
| **2. Autonomous Startup** | Click **Start Simulation** (5 students, 3 chairs) | C process spawns; TA begins sleeping; students arrive, take chairs, wake TA; consultations begin. | Verified |
| **3. Full Hallway Capacity** | Set chairs to `1` or `2` with 8 students | Arriving students take available chairs; excess arrivals are turned away with the red "No seat" badge and tallied in "Turned Away". | Verified |
| **4. Zero-Chair Edge Case** | Set chairs to `0` | All arriving students are turned away immediately; program runs stably without crashing. | Verified |
| **5. Responsive Pause / Resume** | Click **Pause** during heavy activity | Simulation clock and all thread operations halt immediately; click **Resume** and execution continues smoothly. | Verified |
| **6. Dynamic Speed Scaling** | Move speed slider from `1.0x` to `4.0x` | Timers scale instantly mid-flight without stalling or thread drift. | Verified |
| **7. Dynamic Student Injection** | Click **+ Add Student** | A new student thread is spawned at runtime and immediately joins the queue and consultation cycle. | Verified |
| **8. Clean Reset & Shutdown** | Click **Reset** | C engine process joins all threads, destroys semaphores/mutexes, and exits with code 0 without orphan/zombie processes. | Verified |
| **9. Reconnection Resilience** | Refresh browser during simulation | WebSocket automatically reconnects, receives `session_init` bootstrap packet, and restores live state. | Verified |

---

## 5. Technology Stack

- **C Engine**: POSIX Threads (`pthread`), POSIX Semaphores (`<semaphore.h>`), Mutexes (`pthread_mutex_t`), Condition Variables (`pthread_cond_t`).
- **Backend**: Node.js, Express, `ws` (WebSocket), `child_process` (stdio pipe IPC).
- **Frontend**: Vanilla HTML5, CSS3 (Custom Properties, Keyframe Animations, Responsive Grid), Canvas API for live telemetry strip charting. Zero heavy dependencies.

