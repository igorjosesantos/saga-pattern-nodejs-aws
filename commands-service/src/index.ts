import * as express from "express";
import { Request, Response, NextFunction } from "express";
import * as bodyParser from "body-parser";

import { DynamoDB, SQS, config } from "aws-sdk";
import * as uuid from "uuid/v4";
import { createLogger, transports, format } from "winston";
import { series } from "async";

import * as dotenv from "dotenv";

import { CommandActions } from "../../shared/actions";

dotenv.config();

const PORT = process.env.PORT || 3001;
const QUEUE_URL = process.env.QUEUE_URL || "";
const ORCHESTRATOR_QUEUE_URL = process.env.ORCHESTRATOR_QUEUE_URL || "";

const COMMANDS_TABLE_NAME = process.env.COMMANDS_TABLE_NAME || "commands";

config.update({
  region: process.env.AWS_REGION || "us-east-1",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
  secretAccessKey: process.env.AWS_SECREt_ACCESS_KEY || ""
});

const dynamoDbClient = new DynamoDB.DocumentClient();
const sqsClient = new SQS();

const logger = createLogger({
  level: "debug",
  format: format.simple(),
  transports: [new transports.Console()]
});

const app = express();

app.use(bodyParser.json());

app.post("/commands", (req: Request, res: Response, next: NextFunction) => {
  const id = uuid();

  const command = {
    id: id,
    date: new Date().toISOString(),
    items: req.body.items,
    status: "IN_PROCESS"
  };

  series(
    [
      insertCommand.bind(null, command),
      sendMessage.bind(null, CommandActions.CREATE, command)
    ],
    err => {
      if (err) return next(err);
      res
        .status(201)
        .header(
          "Location",
          req.protocol + "://" + req.hostname + "/" + req.url + "/" + id
        )
        .send(command);
    }
  );
});

app.delete(
  "/commands/:id",
  (req: Request, res: Response, next: NextFunction) => {
    const id = req.params.id;

    series(
      [
        deleteCommand.bind(null, { id }),
        sendMessage.bind(null, CommandActions.DELETED, { id })
      ],
      err => {
        if (err) return next(err);
        res.status(200).end();
      }
    );
  }
);

app.get("/commands", (req: Request, res: Response, next: NextFunction) => {
  getCommands((err, data) => {
    if (err) return next(err);
    res.send(data);
  });
});

app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).send({ message: "Internal Server Error" });
});

app.listen(PORT, () => {
  logger.info("server started at http://localhost:" + PORT);
});

setInterval(
  () =>
    sqsClient.receiveMessage(
      {
        WaitTimeSeconds: 20,
        MaxNumberOfMessages: 10,
        VisibilityTimeout: 1 * 60, // 1 min wait time for anyone else to process.
        MessageAttributeNames: ["Action"],
        QueueUrl: QUEUE_URL
      },
      (err, data) => {
        if (err) throw err;
        if (data.Messages) {
          logger.debug("Received messages from queue");
          data.Messages.forEach(message => {
            const action = message.MessageAttributes["Action"].StringValue;
            logger.debug("Received action : " + action);
            const command = JSON.parse(message.Body);
            switch (action) {
              case CommandActions.CREATE:
                series(
                  [
                    insertCommand.bind(null, command),
                    sendMessage.bind(null, CommandActions.CREATED, command),
                    deleteMessage.bind(null, message.ReceiptHandle)
                  ],
                  err => {
                    if (err) throw err;
                  }
                );
                break;
              case CommandActions.VALIDATE:
                series(
                  [
                    validateCommand.bind(null, command),
                    sendMessage.bind(null, CommandActions.VALIDATED, command),
                    deleteMessage.bind(null, message.ReceiptHandle)
                  ],
                  err => {
                    if (err) throw err;
                  }
                );
                break;
              case CommandActions.CANCEL:
                series(
                  [
                    cancelCommand.bind(null, command),
                    sendMessage.bind(null, CommandActions.CANCELED, command),
                    deleteMessage.bind(null, message.ReceiptHandle)
                  ],
                  err => {
                    if (err) throw err;
                  }
                );
                break;
              case CommandActions.DELETE:
                const commandId = JSON.parse(message.Body).id;
                series(
                  [
                    deleteCommand.bind(null, commandId),
                    sendMessage.bind(null, CommandActions.DELETED, command),
                    deleteMessage.bind(null, message.ReceiptHandle)
                  ],
                  err => {
                    if (err) throw err;
                  }
                );
                break;
              default:
                return;
            }
          });
        } else {
          logger.debug("Empty response received from queue");
        }
      }
    ),
  1000 * 10 // poll every 10 seconds
);

function insertCommand(command, callback: (err: any, data: any) => void) {
  dynamoDbClient.put(
    {
      TableName: COMMANDS_TABLE_NAME,
      Item: command
    },
    callback
  );
}

function validateCommand(command, callback: (err: any, data: any) => void) {
  dynamoDbClient.update(
    {
      TableName: COMMANDS_TABLE_NAME,
      Key: {
        id: command.id
      },
      UpdateExpression: "set #s = :val",
      ExpressionAttributeNames: {
        "#s": "status"
      },
      ExpressionAttributeValues: {
        ":val": "VALIDATED"
      }
    },
    callback
  );
}

function cancelCommand(command, callback: (err: any, data: any) => void) {
  dynamoDbClient.update(
    {
      TableName: COMMANDS_TABLE_NAME,
      Key: {
        id: command.id
      },
      UpdateExpression: "set #s = :val",
      ExpressionAttributeNames: {
        "#s": "status"
      },
      ExpressionAttributeValues: {
        ":val": "CANCELED"
      }
    },
    callback
  );
}

function deleteCommand(
  commandId: string,
  callback: (err: any, data: any) => void
) {
  dynamoDbClient.delete(
    {
      TableName: COMMANDS_TABLE_NAME,
      Key: {
        id: {
          S: commandId
        }
      }
    },
    callback
  );
}

function getCommands(callback: (err: any, data: any) => void) {
  dynamoDbClient.scan(
    {
      TableName: COMMANDS_TABLE_NAME
    },
    callback
  );
}

function sendMessage(
  action: string,
  command,
  callback: (err: any, data: any) => void
) {
  logger.debug("Sent message to orchestrator queue : " + action);
  const msg = {
    MessageAttributes: {
      Action: {
        DataType: "String",
        StringValue: action
      }
    },
    MessageBody: JSON.stringify(command),
    MessageDeduplicationId: uuid(),
    MessageGroupId: "Commands-" + command.id,
    QueueUrl: ORCHESTRATOR_QUEUE_URL
  };
  sqsClient.sendMessage(msg, callback);
}

function deleteMessage(
  receiptHandle: string,
  callback: (err: any, data: any) => void
) {
  sqsClient.deleteMessage(
    {
      QueueUrl: QUEUE_URL,
      ReceiptHandle: receiptHandle
    },
    callback
  );
}
