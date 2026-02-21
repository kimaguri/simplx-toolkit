GO=go
VERSION=$(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT=$(shell git rev-parse --short HEAD 2>/dev/null || echo "none")
LDFLAGS=-s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT)

.PHONY: build build-devdash build-mxd test clean vet

build: build-devdash build-mxd

build-devdash:
	$(GO) build -ldflags "$(LDFLAGS)" -o devdash ./cmd/local

build-mxd:
	$(GO) build -ldflags "$(LDFLAGS)" -o mxd ./cmd/mxd

test:
	$(GO) test ./... -v

vet:
	$(GO) vet ./...

clean:
	rm -f devdash mxd
