CC ?= gcc
CFLAGS ?= -pthread -Wall -Wextra -O2
TARGET = sta
SRC = sta.c

all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) -o $(TARGET) $(SRC)

clean:
	rm -f $(TARGET)

.PHONY: all clean

