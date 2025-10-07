# Blockchain Indexer Bootstrap Documentation

## Overview

The blockchain indexer application uses a comprehensive bootstrap process that initializes all services, repositories, and dependencies with proper dependency injection and configuration management.

## Architecture

The application follows a layered architecture with dependency injection:

```
┌─────────────────────────────────────┐
│           Bootstrap Layer           │
│  (Configuration & Initialization)   │
├─────────────────────────────────────┤
│           API Layer                 │
│  (Fastify Routes & Validation)      │
├─────────────────────────────────────┤
│         Service Layer               │
│  (Business Logic & Orchestration)   │
├─────────────────────────────────────┤
│        Repository Layer             │
│   (Data Access & Transactions)      │
├─────────────────────────────────────┤
│         Database Layer              │
│      (PostgreSQL Storage)           │
└─────────────────────────────────────┘
```

## Bootstrap Process

### 1. Configuration Loading
- Loads and validates environment variables
- Sets up application configuration with defaults
- Validates required parameters (DATABASE_URL, PORT, etc.)

### 2. Database Initialization
- Creates database connection pool
- Tests database connectivity
- Runs database migrations
- Validates database schema

### 3. Service Initialization
- Creates repository instances (UTXORepository, BalanceRepository)
- Initializes service instances (BlockProcessor)
- Sets up singleton services (ConcurrencyManager, ErrorHandler)

### 4. Dependency Injection
- Registers all services and repositories with Fastify
- Makes dependencies available to route handlers
- Ensures consistent service access across the application

### 5. Route Registration
- Registers all API endpoints
- Applies validation schemas
- Sets up error handling

### 6. Health Monitoring
- Sets up periodic error log cleanup
- Configures system status monitoring
- Enables development logging

### 7. Graceful Shutdown
- Handles SIGTERM and SIGINT signals
- Closes database connections
- Clears pending operations
- Ensures clean application shutdown

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `PORT` | No | 3000 | Server port number |
| `HOST` | No | 0.0.0.0 | Server host address |
| `LOG_LEVEL` | No | info | Logging level (fatal, error, warn, info, debug, trace) |
| `NODE_ENV` | No | development | Environment (development, test, production) |

## Dependency Injection

The application uses Fastify's decoration system to inject dependencies:

```typescript
// Available in all route handlers
fastify.db                    // Database connection
fastify.blockProcessor        // Block processing service
fastify.utxoRepository        // UTXO data access
fastify.balanceRepository     // Balance data access
fastify.services.concurrencyManager  // Concurrency control
fastify.services.errorHandler        // Error handling
```

## Service Lifecycle

### Startup
1. Load configuration
2. Initialize database
3. Create service instances
4. Register dependencies
5. Start HTTP server

### Runtime
- Services are singleton instances shared across requests
- Database connections are pooled and managed automatically
- Error handling and logging are centralized
- Concurrency is managed for sequential block processing

### Shutdown
1. Stop accepting new requests
2. Complete pending operations
3. Close database connections
4. Exit gracefully

## Testing

The test suite includes proper dependency injection setup:

```typescript
// Test setup mirrors production bootstrap
const utxoRepository = new UTXORepository(db);
const balanceRepository = new BalanceRepository(db);
const blockProcessor = new BlockProcessor(db);

app.decorate('db', db);
app.decorate('utxoRepository', utxoRepository);
app.decorate('balanceRepository', balanceRepository);
app.decorate('blockProcessor', blockProcessor);
app.decorate('services', { concurrencyManager, errorHandler });
```

## Error Handling

- Structured error logging with context
- Automatic retry mechanisms for transient failures
- Database transaction rollback on errors
- Graceful degradation for non-critical failures

## Monitoring

- Error statistics tracking
- Concurrency status monitoring
- Database connection health
- System resource usage (in development)

## Configuration Management

Configuration is centralized in `src/config/app.config.ts`:

- Environment variable validation
- Type-safe configuration objects
- Test configuration overrides
- Default value management

## Best Practices

1. **Single Responsibility**: Each service has a clear, focused purpose
2. **Dependency Injection**: All dependencies are explicitly injected
3. **Configuration**: All configuration is externalized and validated
4. **Error Handling**: Comprehensive error handling with structured logging
5. **Testing**: Test setup mirrors production configuration
6. **Graceful Shutdown**: Clean shutdown process for all resources
7. **Monitoring**: Built-in health monitoring and status reporting