# This Ubuntu LTS image supports both Apple Silicon (arm64) and Intel (amd64).
FROM mcr.microsoft.com/devcontainers/base:ubuntu24.04

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*
