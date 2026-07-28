# DEPLOYMENT.md

# Zentariq One Deployment Specification

## Purpose

Define the deployment strategy for development, staging and production.

## Environments

- Local Development
- Staging
- Production

## Platform

- GitHub
- Vercel
- Supabase

## CI/CD

Every push:

- Lint
- Type Check
- Tests
- Build

Main branch:
Automatic deployment to Production.

## Secrets

Store only in Vercel/Supabase secret managers.

## Monitoring

- Runtime logs
- Error tracking
- Performance metrics
- Database health

## Rollback

Every deployment must support rollback.

## Final Rule

Production deployments require passing all automated tests.
