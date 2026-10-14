#!/bin/bash
set -euo pipefail

echo "Creating SQS queues..."

awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

cat > /tmp/main-queue-attrs.json <<EOF
{
  "FifoQueue": "true",
  "VisibilityTimeout": "30",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"5\"}"
}
EOF

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes file:///tmp/main-queue-attrs.json

awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true

echo "Queues created."
