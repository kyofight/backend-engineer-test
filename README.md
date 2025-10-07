# EMURGO Backend Engineer Challenge

This challenge is designed to evaluate your skills with data processing and API development. You will be responsible for creating an indexer that will keep track of the balance of each address in a blockchain.

Please read all instructions bellow carefully.

## Instructions
Fork this repository and make the necessary changes to complete the challenge. Once you are done, simply send your repository link to us and we will review it.

## Setup
This coding challenge uses [Bun](https://bun.sh/) as its runtime. If you are unfamiliar with it, you can follow the instructions on the official website to install it - it works pretty much the same as NodeJS, but has a ton of features that make our life easier, like a built-in test engine and TypeScript compiler.

Strictly speaking, because we run this project on Docker, you don't even need to have Bun installed on your machine. You can run the project using the `docker-compose` command, as described below.

The setup for this coding challenge is quite simple. You need to have `docker` and `docker-compose` installed on your machine. If you don't have them installed, you can follow the instructions on the official docker website to install them.

https://docs.docker.com/engine/install/
https://docs.docker.com/compose/install/

Once you have `docker` and `docker-compose` installed, you can run the following command to start the application:

```bash
docker-compose up -d --build
```

or using `Bun`

```bash
bun run-docker
```

## The Challenge
Your job is to create an indexer that will keep track of the current balance for each address. To do that, you will need to implement the following endpoints:

### `POST /blocks`
This endpoint will receive a JSON object that should match the `Block` type from the following schema:

```ts
Output = {
  address: string;
  value: number;
}

Input = {
  txId: string;
  index: number;
}

Transaction = {
  id: string;
  inputs: Array<Input>
  outputs: Array<Output>
}

Block = {
  id: string;
  height: number;
  transactions: Array<Transaction>;
}
```

Based on the received message you should update the balance of each address accordingly. This endpoint should also run the following validations:
- validate if the `height` is exactly one unit higher than the current height - this also means that the first ever block should have `height = 1`. If it is not, you should return a `400` status code with an appropriate message;
- validate if the sum of the values of the inputs is exactly equal to the sum of the values of the outputs. If it is not, you should return a `400` status code with an appropriate message;
- validate if the `id` of the Block correct. For that, the `id` of the block must be the sha256 hash of the sum of its transaction's ids together with its own height. In other words: `sha256(height + transaction1.id + transaction2.id + ... + transactionN.id)`. If it is not, you should return a `400` status code with an appropriate message;

#### Understanding the Schema
If you are familiar with the UTXO model, you will recognize the schema above. If you are not, here is a brief explanation:
- each transaction is composed of inputs and outputs;
- each input is a reference to an output of a previous transaction;
- each output means a given address **received** a certain amount of value;
- from the above, it follows that each input **spends** a certain amount of value from its original address;
- in summary, the balance of an address is the sum of all the values it received minus the sum of all the values it spent;

### `GET /balance/:address`
This endpoint should return the current balance of the given address. Simple as that.

### `POST /rollback?height=number`
This endpoint should rollback the state of the indexer to the given height. This means that you should undo all the transactions that were added after the given height and recalculate the balance of each address. You can assume the `height` will **never** be more than 2000 blocks from the current height.

## Example
Imagine the following sequence of messages:
```json
{
  height: 1,
  transactions: [{
    id: "tx1",
    inputs: [],
    outputs: [{
      address: "addr1",
      value: 10
    }]
  }]
}
// here we have addr1 with a balance of 10

{
  height: 2,
  transactions: [{
    id: "tx2",
    inputs: [{
      txId: "tx1",
      index: 0
    }],
    outputs: [{
      address: "addr2",
      value: 4
    }, {
      address: "addr3",
      value: 6
    }]
  }]
}
// here we have addr1 with a balance of 0, addr2 with a balance of 4 and addr3 with a balance of 6

{
  height: 3,
  transactions: [{
    id: "tx3",
    inputs: [{
      txId: "tx2",
      index: 1
    }],
    outputs: [{
      address: "addr4",
      value: 2
    }, {
      address: "addr5",
      value: 2
    }, {
      address: "addr6",
      value: 2
    }]
  }]
}
// here we have addr1 with a balance of 0, addr2 with a balance of 4, addr3 with a balance of 0 and addr4, addr5 and addr6 with a balance of 2
```

Then, if you receive the request `POST /rollback?height=2`, you should undo the last transaction which will lead to the state where we have addr1 with a balance of 0, addr2 with a balance of 4 and addr3 with a balance of 6.

## Tests
You should write tests for all the operations described above. Anything you put on the `spec` folder in the format `*.spec.ts` will be run by the test engine.

Here we are evaluating your capacity to understand what should be tested and how. Are you going to create abstractions and mock dependencies? Are you going to test the database layer? Are you going to test the API layer? That's all up to you.

## API Documentation

The API includes comprehensive OpenAPI/Swagger documentation that provides detailed information about all endpoints, request/response schemas, and examples.

### Accessing the Documentation

Once the application is running, you can access the interactive API documentation at:

- **Swagger UI**: http://localhost:3000/docs
- **OpenAPI Specification**: Available in `docs/openapi.yaml`

### Available Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Service status check |
| GET | `/health` | Detailed system health information |
| GET | `/metrics` | System metrics for monitoring |
| POST | `/blocks` | Process a new block |
| GET | `/balance/:address` | Get balance for a specific address |
| POST | `/rollback` | Rollback blockchain state to a specific height |

### Example API Usage

```bash
# Check service status
curl http://localhost:3000/

# Get system health
curl http://localhost:3000/health

# Get address balance
curl http://localhost:3000/balance/addr_user123

# Process a new block
curl -X POST http://localhost:3000/blocks \
  -H "Content-Type: application/json" \
  -d '{
    "height": 1,
    "id": "block_abc123",
    "transactions": [{
      "id": "tx_xyz789",
      "inputs": [],
      "outputs": [{
        "address": "addr_user123",
        "value": 100
      }]
    }]
  }'

# Rollback to height 10
curl -X POST http://localhost:3000/rollback \
  -H "Content-Type: application/json" \
  -d '{"height": 10}'
```

## Database Resilience

The application includes comprehensive database resilience features to handle connection issues gracefully:

### Database-Optional Bootstrap

The application **starts successfully even without a database connection**:

- API server starts immediately and serves health endpoints
- Database connection attempts continue in the background
- Services become fully functional once database is available
- No more bootstrap failures due to database unavailability

### Automatic Database Reconnection

The application automatically handles database connection loss:

- **Continuous reconnection attempts** with exponential backoff
- **Health monitoring** with periodic connection checks
- **Graceful degradation** when database is unavailable
- **Automatic recovery** when database becomes available again

### Configuration

#### Database Manager Configuration

```bash
DB_MAX_RECONNECT_ATTEMPTS=-1       # Max reconnection attempts (-1 = infinite)
DB_RECONNECT_BASE_DELAY_MS=2000    # Base delay between reconnection attempts (ms)
DB_RECONNECT_MAX_DELAY_MS=30000    # Maximum delay between reconnection attempts (ms)
DB_RECONNECT_BACKOFF_MULTIPLIER=1.5 # Reconnection backoff multiplier
DB_HEALTH_CHECK_INTERVAL_MS=30000  # Health check interval (ms)
DB_CONNECTION_TIMEOUT_MS=10000     # Connection timeout (ms)
```

### Behavior

#### Startup Without Database
1. Application starts immediately
2. API endpoints become available
3. Health endpoint reports database status
4. Database operations queue until connection is established
5. Full functionality resumes automatically when database is ready

#### Connection Loss Recovery
1. Database connection loss is detected automatically
2. Application continues serving non-database requests
3. Database operations return appropriate error messages
4. Reconnection attempts continue in background
5. Full functionality resumes when connection is restored

### API Behavior During Database Outages

- **Health endpoints** (`/`, `/health`, `/metrics`) remain available
- **Swagger documentation** (`/docs`) remains available
- **Block processing** returns "Database not available" errors
- **Balance queries** returns "Database not available" errors
- **Rollback operations** returns "Database not available" errors

## Further Instructions
- We expect you to handle errors and edge cases. Understanding what these are and how to handle them is part of the challenge;
- We provided you with a setup to run the API and a Postgres database together using Docker, as well as some sample code to test the database connection. You can change this setup to use any other database you'd like;