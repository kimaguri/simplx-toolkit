BINARY_NAME=devdash
GO=go
VERSION=$(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT=$(shell git rev-parse --short HEAD 2>/dev/null || echo "none")
LDFLAGS=-s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT)

.PHONY: build test clean vet

build:
	$(GO) build -ldflags "$(LDFLAGS)" -o $(BINARY_NAME) ./cmd/local

test:
	$(GO) test ./... -v

vet:
	$(GO) vet ./...

clean:
	rm -f $(BINARY_NAME)
