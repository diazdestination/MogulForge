#!/bin/bash
set -e

# Install any dependencies added by merged tasks (fast no-op when unchanged)
npm install --no-audit --no-fund
