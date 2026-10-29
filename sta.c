/*
 * Sleeping Teaching Assistant Problem (STA)
 *
 * Implements the classic synchronization problem using POSIX threads,
 * mutexes, and semaphores with cross-platform support (Linux/macOS).
 *
 * Concurrency Architecture:
 *  - 1 TA thread: sleeps on students_sem; wakes to help waiting students in FIFO order.
 *  - N Student threads: alternate between independent programming and office visits.
 *  - Semaphores:
 *      * students_sem: counts students waiting in hallway chairs (starts at 0).
 *      * ta_sem: signals that TA is ready to begin consultation with invited student (starts at 0).
 *      * ta_done_sem: signals that consultation has concluded (starts at 0).
 *  - Mutexes & Condition Variables:
 *      * chair_mutex: protects chairs array, circular FIFO queue, and statistics.
 *      * student_called_cv: condition variable signaling invited student from FIFO queue.
 *      * io_mutex: serializes newline-delimited JSON events to stdout.
 *      * ctrl_mutex + ctrl_cv: manages simulation pause/resume, speed scaling, and exit safely.
 *  - 1 Input thread: processes commands from stdin (PAUSE, RESUME, SPEED, SPAWN, QUIT).
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>
#include <semaphore.h>
#include <fcntl.h>
#include <sys/time.h>
#include <time.h>
#include <errno.h>
#include <signal.h>
#include <stdarg.h>

#define MAX_STUDENTS 64
#define MAX_CHAIRS   32

/*
 * Portable POSIX Semaphore Abstraction:
 * macOS deprecates sem_init and sem_destroy (returns ENOSYS at runtime).
 * We use sem_open with unique IPC names on macOS, and sem_init on Linux.
 */
#ifdef __APPLE__
typedef struct {
    sem_t *sem;
    char name[64];
} posix_sem_t;

static inline int posix_sem_init(posix_sem_t *s, int pshared, unsigned int value) {
    (void)pshared;
    static int sem_counter = 0;
    snprintf(s->name, sizeof(s->name), "/sta_sem_%d_%d", (int)getpid(), ++sem_counter);
    sem_unlink(s->name);
    s->sem = sem_open(s->name, O_CREAT | O_EXCL, 0644, value);
    return (s->sem == SEM_FAILED) ? -1 : 0;
}
static inline int posix_sem_wait(posix_sem_t *s) { return sem_wait(s->sem); }
static inline int posix_sem_post(posix_sem_t *s) { return sem_post(s->sem); }
static inline int posix_sem_destroy(posix_sem_t *s) {
    if (s->sem != SEM_FAILED && s->sem != NULL) {
        sem_close(s->sem);
        sem_unlink(s->name);
        s->sem = SEM_FAILED;
    }
    return 0;
}
#else
typedef struct {
    sem_t sem;
} posix_sem_t;

static inline int posix_sem_init(posix_sem_t *s, int pshared, unsigned int value) {
    return sem_init(&s->sem, pshared, value);
}
static inline int posix_sem_wait(posix_sem_t *s) { return sem_wait(&s->sem); }
static inline int posix_sem_post(posix_sem_t *s) { return sem_post(&s->sem); }
static inline int posix_sem_destroy(posix_sem_t *s) { return sem_destroy(&s->sem); }
#endif

/* Simulation Parameters (configurable via CLI or defaults) */
static int num_students = 5;
static int num_chairs = 3;
static int min_help_ms = 1000;
static int max_help_ms = 3000;
static int min_arrival_ms = 2000;
static int max_arrival_ms = 5000;

/* Concurrency Primitives */
static posix_sem_t students_sem;
static posix_sem_t ta_sem;
static posix_sem_t ta_done_sem;

static pthread_mutex_t chair_mutex       = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t  student_called_cv = PTHREAD_COND_INITIALIZER;
static pthread_mutex_t io_mutex          = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t ctrl_mutex        = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t  ctrl_cv           = PTHREAD_COND_INITIALIZER;

/* Shared Simulation State (protected by chair_mutex) */
static int chairs[MAX_CHAIRS];
static int chairs_occupied = 0;
static int queue[MAX_STUDENTS];
static int q_head = 0, q_tail = 0, q_count = 0;
static int current_helped_student = -1;
static long student_arrival_time[MAX_STUDENTS];

/* Statistics (protected by chair_mutex) */
static int total_served = 0;
static int total_turned_away = 0;
static long long total_wait_time_ms = 0;
static int wait_count = 0;
static long long total_ta_busy_ms = 0;

/* Control State (protected by ctrl_mutex) */
static volatile int running = 1;
static volatile int is_paused = 0;
static volatile double speed_factor = 1.0;

/* Threads and IDs */
static pthread_t ta_tid;
static pthread_t input_tid;
static pthread_t student_tids[MAX_STUDENTS];
static int student_ids[MAX_STUDENTS];
static int total_spawned_students = 0;

/* Monotonic simulation clock */
static struct timespec sim_start_time;

static long get_time_ms(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (long)((now.tv_sec - sim_start_time.tv_sec) * 1000 +
                  (now.tv_nsec - sim_start_time.tv_nsec) / 1000000);
}

/* Thread-safe JSON line emitter */
static void emit_json(const char *fmt, ...) {
    pthread_mutex_lock(&io_mutex);
    va_list args;
    va_start(args, fmt);
    vprintf(fmt, args);
    va_end(args);
    printf("\n");
    fflush(stdout);
    pthread_mutex_unlock(&io_mutex);
}

/* Helper to format current queue snapshot as JSON array string: "[1,4,2]" */
static void format_queue_json(char *buf, size_t max_len) {
    if (max_len == 0) return;
    buf[0] = '[';
    buf[1] = '\0';
    size_t curr = 1;
    for (int i = 0; i < q_count; i++) {
        int idx = (q_head + i) % MAX_STUDENTS;
        char item[16];
        snprintf(item, sizeof(item), "%s%d", (i > 0 ? "," : ""), queue[idx]);
        size_t ilen = strlen(item);
        if (curr + ilen + 2 < max_len) {
            strcat(buf, item);
            curr += ilen;
        }
    }
    if (curr + 1 < max_len) {
        buf[curr] = ']';
        buf[curr + 1] = '\0';
    } else {
        buf[max_len - 1] = '\0';
    }
}

/* Enqueue student to FIFO queue */
static void enqueue(int id) {
    if (q_count < MAX_STUDENTS) {
        queue[q_tail] = id;
        q_tail = (q_tail + 1) % MAX_STUDENTS;
        q_count++;
    }
}

/* Dequeue student from FIFO queue */
static int dequeue(void) {
    if (q_count == 0) return -1;
    int id = queue[q_head];
    q_head = (q_head + 1) % MAX_STUDENTS;
    q_count--;
    return id;
}

/* Random integer helper in [min, max] */
static int rand_range(int min_val, int max_val) {
    if (min_val >= max_val) return min_val;
    return min_val + (rand() % (max_val - min_val + 1));
}

/* Emit current simulation statistics */
static void emit_stats(void) {
    pthread_mutex_lock(&chair_mutex);
    long sim_elapsed = get_time_ms();
    long avg_wait = (wait_count > 0) ? (long)(total_wait_time_ms / wait_count) : 0;
    int busy_pct = (sim_elapsed > 0) ? (int)((total_ta_busy_ms * 100) / sim_elapsed) : 0;
    if (busy_pct > 100) busy_pct = 100;

    emit_json("{\"t\":%ld,\"type\":\"stats\",\"served\":%d,\"turned_away\":%d,\"avg_wait\":%ld,\"ta_busy_pct\":%d,\"queue_len\":%d,\"occupied_chairs\":%d}",
              sim_elapsed, total_served, total_turned_away, avg_wait, busy_pct, q_count, chairs_occupied);
    pthread_mutex_unlock(&chair_mutex);
}

/*
 * Responsive sleep function:
 * Dynamically scales sleep time according to speed_factor.
 * Checks for pause state and wakes instantly on resume or shutdown.
 */
static void sim_sleep(long ms) {
    pthread_mutex_lock(&ctrl_mutex);
    long remaining = ms;
    while (remaining > 0 && running) {
        while (is_paused && running) {
            pthread_cond_wait(&ctrl_cv, &ctrl_mutex);
        }
        if (!running) break;

        long slice = (remaining > 40) ? 40 : remaining;
        double speed = (speed_factor > 0.05) ? speed_factor : 0.05;
        long usec = (long)((slice * 1000.0) / speed);

        pthread_mutex_unlock(&ctrl_mutex);
        usleep((useconds_t)usec);
        pthread_mutex_lock(&ctrl_mutex);

        remaining -= slice;
    }
    pthread_mutex_unlock(&ctrl_mutex);
}

/*
 * Teaching Assistant Thread
 * Logic:
 * 1. Sleep on students_sem when no students are waiting.
 * 2. When awakened, wake student at head of FIFO queue.
 * 3. Free student's chair, signal ta_sem to start consultation.
 * 4. Help student for random duration.
 * 5. Signal ta_done_sem, update stats, and repeat or sleep.
 */
static void *ta_thread_func(void *arg) {
    (void)arg;
    emit_json("{\"t\":%ld,\"type\":\"ta_sleep\"}", get_time_ms());

    while (running) {
        /* TA sleeps waiting for students_sem */
        posix_sem_wait(&students_sem);
        if (!running) break;

        emit_json("{\"t\":%ld,\"type\":\"ta_wake\"}", get_time_ms());

        /* Retrieve next student in arrival order from queue under mutex */
        pthread_mutex_lock(&chair_mutex);
        if (q_count == 0) {
            pthread_mutex_unlock(&chair_mutex);
            continue;
        }

        int student_id = dequeue();
        int freed_chair = -1;
        for (int i = 0; i < num_chairs; i++) {
            if (chairs[i] == student_id) {
                freed_chair = i;
                chairs[i] = -1;
                chairs_occupied--;
                break;
            }
        }

        current_helped_student = student_id;
        long now = get_time_ms();
        long wait_time = (student_arrival_time[student_id] > 0) ? (now - student_arrival_time[student_id]) : 0;
        total_wait_time_ms += wait_time;
        wait_count++;

        char q_buf[256];
        format_queue_json(q_buf, sizeof(q_buf));
        int help_dur = rand_range(min_help_ms, max_help_ms);

        /* Signal the invited student thread that their turn has arrived */
        pthread_cond_broadcast(&student_called_cv);
        pthread_mutex_unlock(&chair_mutex);

        /* Signal ta_sem: TA is ready to begin consultation */
        posix_sem_post(&ta_sem);

        /* Emit help_start */
        emit_json("{\"t\":%ld,\"type\":\"help_start\",\"id\":%d,\"chair\":%d,\"duration\":%d,\"queue\":%s}",
                  get_time_ms(), student_id, freed_chair, help_dur, q_buf);

        /* Conduct consultation */
        long session_start = get_time_ms();
        sim_sleep(help_dur);
        long session_actual = get_time_ms() - session_start;

        pthread_mutex_lock(&chair_mutex);
        total_served++;
        total_ta_busy_ms += session_actual;
        int remaining_in_queue = q_count;
        pthread_mutex_unlock(&chair_mutex);

        emit_json("{\"t\":%ld,\"type\":\"help_end\",\"id\":%d}", get_time_ms(), student_id);
        emit_stats();

        /* Unblock the student so they can exit the office and resume coding */
        posix_sem_post(&ta_done_sem);

        pthread_mutex_lock(&chair_mutex);
        current_helped_student = -1;
        pthread_mutex_unlock(&chair_mutex);

        /* If no one is waiting in hallway chairs, TA goes back to sleep */
        if (remaining_in_queue == 0 && running) {
            emit_json("{\"t\":%ld,\"type\":\"ta_sleep\"}", get_time_ms());
        }
    }
    return NULL;
}

/*
 * Student Thread
 * Lifecycle:
 * 1. Program independently for random arrival interval.
 * 2. Arrive at TA office.
 * 3. Under chair_mutex, check if chair is free:
 *    - If free: occupy chair, join FIFO queue, signal students_sem, wait on student_called_cv.
 *    - If full: leave office (turned away), resume programming, retry later.
 * 4. When called, handshake on ta_sem and enter office.
 * 5. Wait on ta_done_sem for session end, then return to programming.
 */
static void *student_thread_func(void *arg) {
    int id = *(int *)arg;

    while (running) {
        /* Phase 1: Programming / independent thinking */
        int prog_time = rand_range(min_arrival_ms, max_arrival_ms);
        sim_sleep(prog_time);
        if (!running) break;

        /* Phase 2: Arrive at TA office */
        long arrive_time = get_time_ms();
        emit_json("{\"t\":%ld,\"type\":\"student_arrive\",\"id\":%d}", arrive_time, id);

        /* Phase 3: Check waiting chairs under chair_mutex */
        pthread_mutex_lock(&chair_mutex);
        student_arrival_time[id] = arrive_time;

        if (chairs_occupied < num_chairs) {
            int assigned_chair = -1;
            for (int i = 0; i < num_chairs; i++) {
                if (chairs[i] == -1) {
                    assigned_chair = i;
                    chairs[i] = id;
                    chairs_occupied++;
                    break;
                }
            }
            enqueue(id);

            char q_buf[256];
            format_queue_json(q_buf, sizeof(q_buf));

            emit_json("{\"t\":%ld,\"type\":\"student_sit\",\"id\":%d,\"chair\":%d,\"queue\":%s}",
                      get_time_ms(), id, assigned_chair, q_buf);

            /* Signal TA that a student is waiting */
            posix_sem_post(&students_sem);

            /* Wait until TA specifically calls this student from the FIFO queue */
            while (running && current_helped_student != id) {
                pthread_cond_wait(&student_called_cv, &chair_mutex);
            }
            pthread_mutex_unlock(&chair_mutex);
            if (!running) break;

            /* Handshake with TA: wait on ta_sem */
            posix_sem_wait(&ta_sem);
            if (!running) break;

            /* Consultation underway: wait until TA concludes session */
            posix_sem_wait(&ta_done_sem);
            if (!running) break;

            /* Consultation finished: return to programming */
        } else {
            /* Hallway chairs are full; student leaves */
            total_turned_away++;
            emit_json("{\"t\":%ld,\"type\":\"student_leave_full\",\"id\":%d}", get_time_ms(), id);
            pthread_mutex_unlock(&chair_mutex);
            emit_stats();
        }
    }
    return NULL;
}

/* Spawn an additional student thread dynamically */
static void spawn_new_student(void) {
    pthread_mutex_lock(&chair_mutex);
    if (total_spawned_students >= MAX_STUDENTS) {
        pthread_mutex_unlock(&chair_mutex);
        return;
    }
    int new_id = total_spawned_students++;
    student_ids[new_id] = new_id;
    pthread_create(&student_tids[new_id], NULL, student_thread_func, &student_ids[new_id]);
    pthread_mutex_unlock(&chair_mutex);

    emit_json("{\"t\":%ld,\"type\":\"student_spawned\",\"id\":%d,\"total_students\":%d}",
              get_time_ms(), new_id, total_spawned_students);
}

static void signal_all_to_exit(void) {
    pthread_mutex_lock(&ctrl_mutex);
    if (!running) {
        pthread_mutex_unlock(&ctrl_mutex);
        return;
    }
    running = 0;
    pthread_cond_broadcast(&ctrl_cv);
    pthread_mutex_unlock(&ctrl_mutex);

    /* Wake all waiting students */
    pthread_mutex_lock(&chair_mutex);
    pthread_cond_broadcast(&student_called_cv);
    pthread_mutex_unlock(&chair_mutex);

    /* Wake TA thread if waiting on students_sem */
    posix_sem_post(&students_sem);

    /* Wake any thread waiting on ta_sem or ta_done_sem */
    for (int i = 0; i < MAX_STUDENTS; i++) {
        posix_sem_post(&ta_sem);
        posix_sem_post(&ta_done_sem);
    }
}

/*
 * Input Thread
 * Reads commands from standard input:
 *  - PAUSE: pauses the simulation clock and thread loops
 *  - RESUME: unpauses the simulation
 *  - SPEED <float>: updates the speed multiplier (0.1x to 10.0x)
 *  - SPAWN: dynamically creates a new student thread
 *  - QUIT / STOP: signals all threads to exit gracefully
 */
static void *input_thread_func(void *arg) {
    (void)arg;
    char line[128];
    while (running && fgets(line, sizeof(line), stdin) != NULL) {
        line[strcspn(line, "\r\n")] = '\0';
        if (strlen(line) == 0) continue;

        if (strcasecmp(line, "PAUSE") == 0) {
            pthread_mutex_lock(&ctrl_mutex);
            is_paused = 1;
            pthread_mutex_unlock(&ctrl_mutex);
            emit_json("{\"t\":%ld,\"type\":\"sim_paused\"}", get_time_ms());
        } else if (strcasecmp(line, "RESUME") == 0) {
            pthread_mutex_lock(&ctrl_mutex);
            is_paused = 0;
            pthread_cond_broadcast(&ctrl_cv);
            pthread_mutex_unlock(&ctrl_mutex);
            emit_json("{\"t\":%ld,\"type\":\"sim_resumed\"}", get_time_ms());
        } else if (strncasecmp(line, "SPEED ", 6) == 0) {
            double s = atof(line + 6);
            if (s >= 0.05 && s <= 10.0) {
                pthread_mutex_lock(&ctrl_mutex);
                speed_factor = s;
                pthread_cond_broadcast(&ctrl_cv);
                pthread_mutex_unlock(&ctrl_mutex);
                emit_json("{\"t\":%ld,\"type\":\"speed_change\",\"speed\":%.2f}", get_time_ms(), speed_factor);
            }
        } else if (strcasecmp(line, "SPAWN") == 0 || strcasecmp(line, "ADD_STUDENT") == 0) {
            spawn_new_student();
        } else if (strcasecmp(line, "QUIT") == 0 || strcasecmp(line, "STOP") == 0) {
            break;
        }
    }

    signal_all_to_exit();
    return NULL;
}

static void sigint_handler(int sig) {
    (void)sig;
    signal_all_to_exit();
}

int main(int argc, char *argv[]) {
    srand((unsigned int)time(NULL) ^ (unsigned int)getpid());

    /* Parse CLI arguments if provided:
     * argv[1]: num_students
     * argv[2]: num_chairs
     * argv[3]: min_help_ms
     * argv[4]: max_help_ms
     * argv[5]: min_arrival_ms
     * argv[6]: max_arrival_ms
     */
    if (argc > 1) num_students = atoi(argv[1]);
    if (argc > 2) num_chairs = atoi(argv[2]);
    if (argc > 3) min_help_ms = atoi(argv[3]);
    if (argc > 4) max_help_ms = atoi(argv[4]);
    if (argc > 5) min_arrival_ms = atoi(argv[5]);
    if (argc > 6) max_arrival_ms = atoi(argv[6]);

    if (num_students < 1) num_students = 1;
    if (num_students > MAX_STUDENTS) num_students = MAX_STUDENTS;
    if (num_chairs < 0) num_chairs = 0;
    if (num_chairs > MAX_CHAIRS) num_chairs = MAX_CHAIRS;
    if (min_help_ms < 100) min_help_ms = 100;
    if (max_help_ms < min_help_ms) max_help_ms = min_help_ms;
    if (min_arrival_ms < 100) min_arrival_ms = 100;
    if (max_arrival_ms < min_arrival_ms) max_arrival_ms = min_arrival_ms;

    clock_gettime(CLOCK_MONOTONIC, &sim_start_time);

    signal(SIGINT, sigint_handler);
    signal(SIGTERM, sigint_handler);

    /* Initialize chairs array */
    for (int i = 0; i < MAX_CHAIRS; i++) {
        chairs[i] = -1;
    }

    /* Initialize semaphores */
    if (posix_sem_init(&students_sem, 0, 0) != 0) {
        perror("Failed to initialize students_sem");
        return 1;
    }
    if (posix_sem_init(&ta_sem, 0, 0) != 0) {
        perror("Failed to initialize ta_sem");
        posix_sem_destroy(&students_sem);
        return 1;
    }
    if (posix_sem_init(&ta_done_sem, 0, 0) != 0) {
        perror("Failed to initialize ta_done_sem");
        posix_sem_destroy(&students_sem);
        posix_sem_destroy(&ta_sem);
        return 1;
    }

    total_spawned_students = num_students;

    /* Emit startup event */
    emit_json("{\"t\":%ld,\"type\":\"init\",\"students\":%d,\"chairs\":%d,\"min_help\":%d,\"max_help\":%d,\"min_arr\":%d,\"max_arr\":%d}",
              get_time_ms(), num_students, num_chairs, min_help_ms, max_help_ms, min_arrival_ms, max_arrival_ms);

    /* Start input thread */
    pthread_create(&input_tid, NULL, input_thread_func, NULL);

    /* Start TA thread */
    pthread_create(&ta_tid, NULL, ta_thread_func, NULL);

    /* Start Student threads */
    for (int i = 0; i < num_students; i++) {
        student_ids[i] = i;
        pthread_create(&student_tids[i], NULL, student_thread_func, &student_ids[i]);
    }

    /* Wait for input thread to finish (when QUIT received or stdin closed) */
    pthread_join(input_tid, NULL);

    /* Signal termination and join TA and Student threads */
    signal_all_to_exit();

    pthread_join(ta_tid, NULL);
    for (int i = 0; i < total_spawned_students; i++) {
        pthread_join(student_tids[i], NULL);
    }

    /* Cleanup semaphores and mutexes */
    posix_sem_destroy(&students_sem);
    posix_sem_destroy(&ta_sem);
    posix_sem_destroy(&ta_done_sem);
    pthread_mutex_destroy(&chair_mutex);
    pthread_cond_destroy(&student_called_cv);
    pthread_mutex_destroy(&io_mutex);
    pthread_mutex_destroy(&ctrl_mutex);
    pthread_cond_destroy(&ctrl_cv);

    emit_json("{\"t\":%ld,\"type\":\"sim_exit\"}", get_time_ms());
    return 0;
}
