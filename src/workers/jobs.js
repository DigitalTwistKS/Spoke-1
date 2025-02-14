import { config } from "../config";
import logger from "../logger";
import {
  r,
  datawarehouse,
  cacheableData,
  Assignment,
  Campaign,
  CampaignContact,
  Organization,
  User,
  UserOrganization
} from "../server/models";
import { gunzip, zipToTimeZone, convertOffsetsToStrings } from "../lib";
import { updateJob } from "./lib";
import { getFormattedPhoneNumber } from "../lib/phone-format.js";
import serviceMap from "../server/api/lib/services";
import {
  assignMissingMessagingServices,
  getLastMessage,
  saveNewIncomingMessage
} from "../server/api/lib/message-sending";
import NumbersClient from "assemble-numbers-client";

import AWS from "aws-sdk";
import Papa from "papaparse";
import moment from "moment";
import _ from "lodash";
import { sendEmail } from "../server/mail";
import { Notifications, sendUserNotification } from "../server/notifications";
import s3 from "./exports/s3";
import gsJson from "./exports/gs-json";
import zipCodeToTimeZone from "zipcode-to-timezone";

const CHUNK_SIZE = 1000;
const BATCH_SIZE = Math.max(1, Math.floor(config.DB_MAX_POOL * 0.5));

const zipMemoization = {};
let warehouseConnection = null;
function optOutsByOrgId(orgId) {
  return r.knex
    .select("cell")
    .from("opt_out")
    .where("organization_id", orgId);
}

function optOutsByInstance() {
  return r.knex.select("cell").from("opt_out");
}

function getOptOutSubQuery(orgId) {
  return !!config.OPTOUTS_SHARE_ALL_ORGS
    ? optOutsByInstance()
    : optOutsByOrgId(orgId);
}

function optOutsByOrgId(orgId) {
  return r.knex
    .select("cell")
    .from("opt_out")
    .where("organization_id", orgId);
}

function optOutsByInstance() {
  return r.knex.select("cell").from("opt_out");
}

function getOptOutSubQuery(orgId) {
  return !!config.OPTOUTS_SHARE_ALL_ORGS
    ? optOutsByInstance()
    : optOutsByOrgId(orgId);
}

export async function sendJobToAWSLambda(job) {
  // job needs to be json-serializable
  // requires a 'command' key which should map to a function in job-processes.js
  logger.info(
    "LAMBDA INVOCATION STARTING",
    job,
    config.AWS_LAMBDA_FUNCTION_NAME
  );

  if (!job.command) {
    logger.error("LAMBDA INVOCATION FAILED: JOB NOT INVOKABLE", job);
    return Promise.reject("Job type not available in job-processes");
  }
  const lambda = new AWS.Lambda();
  const lambdaPayload = JSON.stringify(job);
  if (lambdaPayload.length > 128000) {
    logger.error("LAMBDA INVOCATION FAILED PAYLOAD TOO LARGE");
    return Promise.reject("Payload too large");
  }

  const p = new Promise((resolve, reject) => {
    const result = lambda.invoke(
      {
        FunctionName: config.AWS_LAMBDA_FUNCTION_NAME,
        InvocationType: "Event",
        Payload: lambdaPayload
      },
      (err, data) => {
        if (err) {
          logger.error("LAMBDA INVOCATION FAILED", err, job);
          reject(err);
        } else {
          resolve(data);
        }
      }
    );
    logger.info("LAMBDA INVOCATION RESULT", result);
  });
  return p;
}

export async function processSqsMessages() {
  // hit endpoint on SQS
  // ask for a list of messages from SQS (with quantity tied to it)
  // if SQS has messages, process messages into pending_message_part and dequeue messages (mark them as handled)
  // if SQS doesnt have messages, exit

  if (!config.TWILIO_SQS_QUEUE_URL) {
    return Promise.reject("TWILIO_SQS_QUEUE_URL not set");
  }

  const sqs = new AWS.SQS();

  const params = {
    QueueUrl: config.TWILIO_SQS_QUEUE_URL,
    AttributeNames: ["All"],
    MessageAttributeNames: ["string"],
    MaxNumberOfMessages: 10,
    VisibilityTimeout: 60,
    WaitTimeSeconds: 10,
    ReceiveRequestAttemptId: "string"
  };

  const p = new Promise((resolve, reject) => {
    sqs.receiveMessage(params, async (err, data) => {
      if (err) {
        logger.error(err, err.stack);
        reject(err);
      } else if (data.Messages) {
        logger.info(data);
        for (let i = 0; i < data.Messages.length; i++) {
          const message = data.Messages[i];
          const body = message.Body;
          logger.info("processing sqs queue:", body);
          const twilioMessage = JSON.parse(body);

          await serviceMap.twilio.handleIncomingMessage(twilioMessage);

          sqs.deleteMessage(
            {
              QueueUrl: config.TWILIO_SQS_QUEUE_URL,
              ReceiptHandle: message.ReceiptHandle
            },
            (delMessageErr, delMessageData) => {
              if (delMessageErr) {
                logger.error(delMessageErr, delMessageErr.stack); // an error occurred
              } else {
                logger.info(delMessageData); // successful response
              }
            }
          );
        }
        resolve();
      }
    });
  });
  return p;
}

export async function uploadContacts(job) {
  const campaignId = job.campaign_id;
  // We do this deletion in schema.js but we do it again here just in case the the queue broke and we had a backlog of contact uploads for one campaign
  const campaign = await Campaign.get(campaignId);
  const organization = await Organization.get(campaign.organization_id);
  const orgFeatures = JSON.parse(organization.features || "{}");

  const numbersApiKey = orgFeatures.numbersApiKey;
  let numbersClient, numbersRequest, landlinesFilteredOut;

  await r
    .table("campaign_contact")
    .getAll(campaignId, { index: "campaign_id" })
    .delete();

  let jobPayload = await gunzip(new Buffer(job.payload, "base64"));
  jobPayload = JSON.parse(jobPayload);
  let {
    contacts,
    excludeCampaignIds = [],
    filterOutLandlines = false
  } = jobPayload;

  const shouldRemoveLandlines = filterOutLandlines && numbersApiKey;
  if (shouldRemoveLandlines) {
    logger.info(
      "Initializing Numbers connection - we are filtering out landlines"
    );
    numbersClient = new NumbersClient({ apiKey: numbersApiKey });
    numbersRequest = await numbersClient.lookup.createRequest();
  }

  const maxContacts = parseInt(
    orgFeatures.hasOwnProperty("maxContacts")
      ? orgFeatures.maxContacts
      : config.MAX_CONTACTS,
    10
  );

  if (maxContacts) {
    // note: maxContacts == 0 means no maximum
    contacts = contacts.slice(0, maxContacts);
  }

  for (let index = 0; index < contacts.length; index++) {
    const datum = contacts[index];
    if (datum.zip) {
      // using memoization and large ranges of homogenous zips
      datum.timezone = zipCodeToTimeZone.lookup(datum.zip);
    }
  }

  const jobMessages = await r.knex.transaction(async trx => {
    const resultMessages = [];

    const contactChunks = _.chunk(contacts, CHUNK_SIZE);
    const chunkChunks = _.chunk(contactChunks, BATCH_SIZE);
    let chunksCompleted = 0;

    for (let chunkChunk of chunkChunks) {
      await Promise.all(
        chunkChunk.map(async chunk => {
          const percentComplete = Math.round(
            (chunksCompleted / contactChunks.length) * 100
          );

          try {
            await trx("campaign_contact").insert(chunk);
            if (shouldRemoveLandlines) {
              await numbersRequest.addPhoneNumbers(chunk.map(c => c.cell));
            }
          } catch (exc) {
            logger.error("Error inserting contacts:", exc);
            throw exc;
          }

          chunksCompleted = chunksCompleted + 1;
          await updateJob(job, percentComplete);
        })
      );

      await assignMissingMessagingServices(
        trx,
        campaignId,
        campaign.organization_id
      );
    }

    if (shouldRemoveLandlines) {
      await numbersRequest.close();
      await numbersRequest.waitUntilDone({
        onProgressUpdate: async percentComplete => {
          await updateJob(job, 100 + Math.round(percentComplete * 100));
        }
      });

      landlinesFilteredOut = 0;

      const deleteNumbers = async numbers => {
        landlinesFilteredOut += numbers.length;
        await trx("campaign_contact")
          .where("campaign_id", campaignId)
          .whereIn("cell", numbers.map(n => n.phoneNumber))
          .delete();
      };

      await numbersRequest.landlines.eachPage({
        onPage: deleteNumbers
      });

      await numbersRequest.invalids.eachPage({
        onPage: deleteNumbers
      });

      resultMessages.push(
        `Number of contacts excluded because they were landlines: ${landlinesFilteredOut}`
      );
    }

    try {
      const deleteOptOutCells = await trx("campaign_contact")
        .whereIn("cell", getOptOutSubQuery(campaign.organization_id))
        .where("campaign_id", campaignId)
        .delete();

      if (deleteOptOutCells) {
        resultMessages.push(
          `Number of contacts excluded due to their opt-out status: ${deleteOptOutCells}`
        );
      }
    } catch (exc) {
      logger.error("Error deleting opt-outs:", exc);
      throw exc;
    }

    const whereInParams = excludeCampaignIds.map(_ => "?").join(", ");
    try {
      const { rowCount: exclusionCellCount } =
        excludeCampaignIds.length === 0
          ? { rowCount: 0 }
          : await trx.raw(
              `
          with exclude_cell as (
            select distinct on (campaign_contact.cell)
              campaign_contact.cell
            from
              campaign_contact
            where
              campaign_contact.campaign_id in (${whereInParams})
          )
          delete from
            campaign_contact
          where
            campaign_contact.campaign_id = ?
            and exists (
              select 1
              from exclude_cell
              where exclude_cell.cell = campaign_contact.cell
            )
          ;
        `,
              excludeCampaignIds.concat([campaignId])
            );

      if (exclusionCellCount) {
        resultMessages.push(
          `Number of contacts excluded due to campaign exclusion list: ${exclusionCellCount}`
        );
      }
    } catch (exc) {
      logger.error("Error deleting excluded contacts:", exc);
      throw exc;
    }

    return resultMessages;
  });

  if (job.id) {
    if (jobMessages.length) {
      await r
        .knex("job_request")
        .where("id", job.id)
        .update({ result_message: jobMessages.join("\n") });
    } else {
      await r
        .table("job_request")
        .get(job.id)
        .delete();
    }
  }
  await cacheableData.campaign.reload(campaignId);
}

export async function loadContactsFromDataWarehouseFragment(jobEvent) {
  logger.info(
    "starting loadContactsFromDataWarehouseFragment",
    jobEvent.campaignId,
    jobEvent.limit,
    jobEvent.offset,
    jobEvent
  );
  const insertOptions = {
    batchSize: 1000
  };
  const jobCompleted = await r
    .reader("job_request")
    .where("id", jobEvent.jobId)
    .select("status")
    .first();
  if (!jobCompleted) {
    logger.error(
      "loadContactsFromDataWarehouseFragment job no longer exists",
      jobEvent.campaignId,
      jobCompleted,
      jobEvent
    );
    return { alreadyComplete: 1 };
  }

  let sqlQuery = jobEvent.query;
  if (jobEvent.limit) {
    sqlQuery += " LIMIT " + jobEvent.limit;
  }
  if (jobEvent.offset) {
    sqlQuery += " OFFSET " + jobEvent.offset;
  }
  let knexResult;
  try {
    warehouseConnection = warehouseConnection || datawarehouse();
    logger.error(
      "loadContactsFromDataWarehouseFragment RUNNING WAREHOUSE query",
      sqlQuery
    );
    knexResult = await warehouseConnection.raw(sqlQuery);
  } catch (err) {
    // query failed
    logger.error("Data warehouse query failed: ", err);
    jobMessages.push(`Data warehouse count query failed with ${err}`);
    // TODO: send feedback about job
  }
  const fields = {};
  const customFields = {};
  const contactFields = {
    first_name: 1,
    last_name: 1,
    cell: 1,
    zip: 1,
    external_id: 1
  };
  knexResult.fields.forEach(f => {
    fields[f.name] = 1;
    if (!(f.name in contactFields)) {
      customFields[f.name] = 1;
    }
  });
  if (!("first_name" in fields && "last_name" in fields && "cell" in fields)) {
    logger.error(
      "SQL statement does not return first_name, last_name, and cell: ",
      sqlQuery,
      fields
    );
    jobMessages.push(
      `SQL statement does not return first_name, last_name and cell => ${sqlQuery} => with fields ${fields}`
    );
    return;
  }

  const savePortion = await Promise.all(
    knexResult.rows.map(async row => {
      const formatCell = getFormattedPhoneNumber(
        row.cell,
        config.PHONE_NUMBER_COUNTRY
      );
      const contact = {
        campaign_id: jobEvent.campaignId,
        first_name: row.first_name || "",
        last_name: row.last_name || "",
        cell: formatCell,
        zip: row.zip || "",
        external_id: row.external_id ? String(row.external_id) : "",
        assignment_id: null,
        message_status: "needsMessage"
      };
      const contactCustomFields = {};
      Object.keys(customFields).forEach(f => {
        contactCustomFields[f] = row[f];
      });
      contact.custom_fields = JSON.stringify(contactCustomFields);
      if (contact.zip && !contactCustomFields.hasOwnProperty("timezone")) {
        contact.timezone = zipCodeToTimeZone.lookup(contact.zip);
      }
      if (contactCustomFields.hasOwnProperty("timezone")) {
        const zone = moment.tz.zone(contactCustomFields.timezone);
        if (zone) contact.timezone = contactCustomFields.timezone;
        else contact.timezone = zipCodeToTimeZone.lookup(contact.zip);
      }
      return contact;
    })
  );

  await CampaignContact.save(savePortion, insertOptions);
  await r
    .knex("job_request")
    .where("id", jobEvent.jobId)
    .increment("status", 1);
  const validationStats = {};
  const completed = await r
    .reader("job_request")
    .where("id", jobEvent.jobId)
    .select("status")
    .first();
  logger.error(
    "loadContactsFromDataWarehouseFragment toward end",
    completed,
    jobEvent
  );

  if (!completed) {
    logger.error(
      "loadContactsFromDataWarehouseFragment job has been deleted",
      completed,
      jobEvent.campaignId
    );
  } else if (jobEvent.totalParts && completed.status >= jobEvent.totalParts) {
    if (jobEvent.organizationId) {
      // now that we've saved them all, we delete everyone that is opted out locally
      // doing this in one go so that we can get the DB to do the indexed cell matching

      // delete optout cells
      await r
        .knex("campaign_contact")
        .whereIn("cell", getOptOutSubQuery(jobEvent.organizationId))
        .where("campaign_id", jobEvent.campaignId)
        .delete()
        .then(result => {
          logger.error(
            `loadContactsFromDataWarehouseFragment # of contacts opted out removed from DW query (${
              jobEvent.campaignId
            }): ${result}`
          );
          validationStats.optOutCount = result;
        });

      // delete invalid cells
      await r
        .knex("campaign_contact")
        .whereRaw("length(cell) != 12")
        .andWhere("campaign_id", jobEvent.campaignId)
        .delete()
        .then(result => {
          logger.error(
            `loadContactsFromDataWarehouseFragment # of contacts with invalid cells removed from DW query (${
              jobEvent.campaignId
            }): ${result}`
          );
          validationStats.invalidCellCount = result;
        });

      // delete duplicate cells
      await r
        .knex("campaign_contact")
        .whereIn(
          "id",
          r
            .knex("campaign_contact")
            .select("campaign_contact.id")
            .leftJoin("campaign_contact AS c2", function joinSelf() {
              this.on("c2.campaign_id", "=", "campaign_contact.campaign_id")
                .andOn("c2.cell", "=", "campaign_contact.cell")
                .andOn("c2.id", ">", "campaign_contact.id");
            })
            .where("campaign_contact.campaign_id", jobEvent.campaignId)
            .whereNotNull("c2.id")
        )
        .delete()
        .then(result => {
          logger.error(
            `loadContactsFromDataWarehouseFragment # of contacts with duplicate cells removed from DW query (${
              jobEvent.campaignId
            }): ${result}`
          );
          validationStats.duplicateCellCount = result;
        });
    }
    await r
      .table("job_request")
      .get(jobEvent.jobId)
      .delete();
    await cacheableData.campaign.reload(jobEvent.campaignId);
    return { completed: 1, validationStats };
  } else if (jobEvent.part < jobEvent.totalParts - 1) {
    const newPart = jobEvent.part + 1;
    const newJob = {
      ...jobEvent,
      part: newPart,
      offset: newPart * jobEvent.step,
      limit: jobEvent.step,
      command: "loadContactsFromDataWarehouseFragmentJob"
    };
    if (config.WAREHOUSE_DB_LAMBDA_ITERATION) {
      logger.info(
        "SENDING TO LAMBDA loadContactsFromDataWarehouseFragment",
        newJob
      );
      await sendJobToAWSLambda(newJob);
      return { invokedAgain: 1 };
    } else {
      return loadContactsFromDataWarehouseFragment(newJob);
    }
  }
}

export async function loadContactsFromDataWarehouse(job) {
  logger.info("STARTING loadContactsFromDataWarehouse", job.payload);
  const jobMessages = [];
  const sqlQuery = job.payload;

  if (!sqlQuery.startsWith("SELECT") || sqlQuery.indexOf(";") >= 0) {
    logger.error(
      "Malformed SQL statement.  Must begin with SELECT and not have any semicolons: ",
      sqlQuery
    );
    return;
  }
  if (!datawarehouse) {
    logger.error("No data warehouse connection, so cannot load contacts", job);
    return;
  }

  let knexCountRes;
  let knexCount;
  try {
    warehouseConnection = warehouseConnection || datawarehouse();
    knexCountRes = await warehouseConnection.raw(
      `SELECT COUNT(*) FROM ( ${sqlQuery} ) AS QUERYCOUNT`
    );
  } catch (err) {
    logger.error("Data warehouse count query failed: ", err);
    jobMessages.push(`Data warehouse count query failed with ${err}`);
  }

  if (knexCountRes) {
    knexCount = knexCountRes.rows[0].count;
    if (!knexCount || knexCount == 0) {
      jobMessages.push("Error: Data warehouse query returned zero results");
    }
  }

  const STEP =
    r.kninky && r.kninky.defaultsUnsupported
      ? 10 // sqlite has a max of 100 variables and ~8 or so are used per insert
      : 10000; // default
  const campaign = await Campaign.get(job.campaign_id);
  const totalParts = Math.ceil(knexCount / STEP);

  if (totalParts > 1 && /LIMIT/.test(sqlQuery)) {
    // We do naive string concatenation when we divide queries up for parts
    // just appending " LIMIT " and " OFFSET " arguments.
    // If there is already a LIMIT in the query then we'll be unable to do that
    // so we error out.  Note that if the total is < 10000, then LIMIT will be respected
    jobMessages.push(
      `Error: LIMIT in query not supported for results larger than ${STEP}. Count was ${knexCount}`
    );
  }

  if (job.id && jobMessages.length) {
    let resultMessages = await r
      .knex("job_request")
      .where("id", job.id)
      .update({ result_message: jobMessages.join("\n") });
    return resultMessages;
  }

  await r
    .knex("campaign_contact")
    .where("campaign_id", job.campaign_id)
    .delete();

  await loadContactsFromDataWarehouseFragment({
    jobId: job.id,
    query: sqlQuery,
    campaignId: job.campaign_id,
    jobMessages,
    // beyond job object:
    organizationId: campaign.organization_id,
    totalParts,
    totalCount: knexCount,
    step: STEP,
    part: 0,
    limit: totalParts > 1 ? STEP : 0 // 0 is unlimited
  });
}

export async function assignTexters(job) {
  // Assigns UNassigned campaign contacts to texters
  // It does NOT re-assign contacts to other texters
  // STEPS:
  // 1. get currentAssignments = all current assignments
  //       .needsMessageCount = contacts that haven't been contacted yet
  // 2. changedAssignments = assignments where texter was removed or needsMessageCount different
  //                  needsMessageCount differ possibilities:
  //                  a. they started texting folks, so needsMessageCount is less
  //                  b. they were assigned a different number by the admin
  // 3. update changed assignments (temporarily) not to be in needsMessage status
  // 4. availableContacts: count of contacts without an assignment
  // 5. forEach texter:
  //        * skip if 'unchanged'
  //        * if new texter, create assignment record
  //        * update X needsMessage campaign_contacts with texter's assignment record
  //             (min of needsMessageCount,availableContacts)
  // 6. delete assignments with a 0 assignment count
  // SCENARIOS:
  // * deleted texter:
  //   ends up in currentAssignments and changedAssignments
  //   marked as demoted texter, so all contacts are set assignment_id=null
  // * texter with fewer count:
  //   ends up in currentAssignments and changedAssignments
  //   marked as demoted texter: all current contacts are removed
  //   iterating over texter, the currentAssignment re-assigns needsMessageCount more texters
  // * new texter
  //   no current/changed assignment
  //   iterating over texter, assignment is created, then apportioned needsMessageCount texters

  /*
  A. clientMessagedCount  or serverMessagedCount: # of contacts assigned and already texted (for a texter)
    aka clientMessagedCount / serverMessagedCount
  B. needsMessageCount: # of contacts assigned but not yet texted (for a texter)
  C. max contacts (for a texter)
  D. pool of unassigned and assignable texters
    aka availableContacts

  In dynamic assignment mode:
    Add new texter
      Create assignment
    Change C
      if new C >= A and new C <> old C:
        Update assignment
      if new C >= A and new C = old C:
        No change
      if new C < A or new C = 0:
        Why are we doing this? If we want to keep someone from texting any more,
          we set their max_contacts to 0, and manually re-assign any of their
          previously texted contacts in the Message Review admin.
          TODO: Form validation should catch the case where C < A.
    Delete texter
      Assignment form currently prevents this (though it might be okay if A = 0).
      To stop a texter from texting any more in the campaign,
      set their max to zero and re-assign their contacts to another texter.

  In standard assignment mode:
    Add new texter
      Create assignment
      Assign B contacts
    Change B
      if new B > old B:
        Update assignment
        Assign (new B - old B) contacts
      if new B = old B:
        No change
      if new B < old B:
        Update assignment
        Unassign (old B - new B) untexted contacts
      if new B = 0:
        Update assignment
    Delete texter
      Not sure we allow this?

  TODO: what happens when we switch modes? Do we allow it?
  */
  const payload = JSON.parse(job.payload);
  const cid = job.campaign_id;
  const campaign = (await r.reader("campaign").where({ id: cid }))[0];
  const texters = payload.texters;
  const currentAssignments = await r
    .knex("assignment")
    .where("assignment.campaign_id", cid)
    .leftJoin(
      "campaign_contact",
      "campaign_contact.assignment_id",
      "assignment.id"
    )
    .groupBy("user_id", "assignment.id")
    .select("user_id", "assignment.id as id", "max_contacts")
    .select(
      r.knex.raw(
        "SUM(CASE campaign_contact.message_status WHEN 'needsMessage' THEN 1 ELSE 0 END) as needs_message_count"
      )
    )
    .select(r.knex.raw("COUNT(campaign_contact.id) as full_contact_count"));

  const unchangedTexters = {}; // max_contacts and needsMessageCount unchanged
  const demotedTexters = {}; // needsMessageCount reduced
  const dynamic = campaign.use_dynamic_assignment;

  // detect changed assignments
  currentAssignments
    .map(assignment => {
      const texter = texters.filter(
        texter => parseInt(texter.id, 10) === assignment.user_id
      )[0];
      if (texter) {
        const unchangedMaxContacts =
          parseInt(texter.maxContacts, 10) === assignment.max_contacts || // integer = integer
          texter.maxContacts === assignment.max_contacts; // null = null
        const unchangedNeedsMessageCount =
          texter.needsMessageCount ===
          parseInt(assignment.needs_message_count, 10);
        if (
          (!dynamic && unchangedNeedsMessageCount) ||
          (dynamic && unchangedMaxContacts)
        ) {
          unchangedTexters[assignment.user_id] = true;
          return null;
        } else if (!dynamic) {
          // standard assignment change
          // If there is a delta between client and server, then accommodate delta (See #322)
          const clientMessagedCount =
            texter.contactsCount - texter.needsMessageCount;
          const serverMessagedCount =
            assignment.full_contact_count - assignment.needs_message_count;

          const numDifferent =
            (texter.needsMessageCount || 0) -
            assignment.needs_message_count -
            Math.max(0, serverMessagedCount - clientMessagedCount);

          if (numDifferent < 0) {
            // got less than before
            demotedTexters[assignment.id] = -numDifferent;
          } else {
            // got more than before: assign the difference
            texter.needsMessageCount = numDifferent;
          }
        }
        return assignment;
      } else {
        // deleted texter
        demotedTexters[assignment.id] = assignment.needs_message_count;
        return assignment;
      }
    })
    .filter(ele => ele !== null);

  // We are now performing writes
  r.knex.transaction(trx => {
    const execute = async () => {
      const demotedAssignmentIds = Object.keys(demotedTexters);
      const demotedChunks = _.chunk(demotedAssignmentIds, CHUNK_SIZE);
      for (const assignmentIds of demotedChunks) {
        // Here we unassign ALL the demotedTexters contacts (not just the demotion count)
        // because they will get reapportioned below
        await trx("campaign_contact")
          .where("assignment_id", "in", assignmentIds)
          .where({
            message_status: "needsMessage"
          })
          .whereRaw(`archived = ${campaign.is_archived}`) // partial index friendly
          .update({ assignment_id: null });
      }

      await updateJob(job, 20);

      let availableContacts = await r.getCount(
        trx("campaign_contact")
          .where({
            assignment_id: null,
            campaign_id: cid
          })
          .whereRaw(`archived = ${campaign.is_archived}`) // partial index friendly
      );

      const newAssignments = [],
        existingAssignments = [],
        dynamicAssignments = [];
      // Do not use `async texter => ...` parallel execution here because `availableContacts`
      // needs to be synchronously updated
      for (let index = 0; index < texters.length; index++) {
        const texter = texters[index];
        const texterId = parseInt(texter.id, 10);
        let maxContacts = null; // no limit

        const texterMax = parseInt(texter.maxContacts, 10);
        const envMax = config.MAX_CONTACTS_PER_TEXTER;
        if (!isNaN(texterMax)) {
          maxContacts = Math.min(texterMax, envMax) || texterMax;
        } else if (!isNaN(envMax)) {
          maxContacts = envMax;
        }

        if (unchangedTexters[texterId]) {
          continue;
        }

        const contactsToAssign = Math.min(
          availableContacts,
          texter.needsMessageCount
        );
        // Avoid creating a new assignment when the texter should get 0
        if (contactsToAssign === 0 && !campaign.use_dynamic_assignment) {
          continue;
        }

        availableContacts = availableContacts - contactsToAssign;
        const existingAssignment = currentAssignments.find(
          ele => ele.user_id === texterId
        );
        if (existingAssignment) {
          const { id, user_id } = existingAssignment;
          if (!dynamic) {
            existingAssignments.push({
              assignment: {
                campaign_id: cid,
                id,
                user_id
              },
              contactsToAssign
            });
          } else {
            dynamicAssignments.push({
              max_contacts: maxContacts,
              id
            });
          }
        } else {
          newAssignments.push({
            assignment: {
              user_id: texterId,
              campaign_id: cid,
              max_contacts: maxContacts
            },
            contactsToAssign
          });
        }

        // Updating texters accounts for 75% of total job
        const textingWork = Math.floor((75 / texters.length) * (index + 1));
        await updateJob(job, textingWork + 20);
      } // end texters.forEach

      // Update dynamic assignments
      await Promise.all(
        dynamicAssignments.map(async assignment => {
          const { id, max_contacts } = assignment;
          await trx("assignment")
            .where({ id })
            .update({ max_contacts });
        })
      );

      /**
       * Using SQL injection to avoid passing archived as a binding
       * Should help with guaranteeing partial index usage
       */
      const assignContacts = async directive => {
        const {
          assignment: { id: assignment_id, campaign_id },
          contactsToAssign
        } = directive;
        await trx.raw(
          `
            with contacts_to_update as (
              select id
              from campaign_contact
              where
                assignment_id is null
                and campaign_id = ?
                and archived = ${campaign.is_archived}
              limit ?
              for update skip locked
            )
            update campaign_contact
            set assignment_id = ?
            from contacts_to_update
            where
              contacts_to_update.id = campaign_contact.id
            ;
          `,
          [campaign_id, contactsToAssign, assignment_id]
        );
      };

      // Assign contacts for updated existing assignments and notify users
      await Promise.all(
        existingAssignments.map(async directive => {
          await assignContacts(directive);
          // Wait to send notification until all contacts have been updated
          // We can't rely on an observer because nothing about the actual assignment object changes
          const { assignment } = directive;
          await sendUserNotification({
            type: Notifications.ASSIGNMENT_UPDATED,
            assignment
          });
          // TODO - this ^^ should send an email, but in fact it does nothing!
          // `sendUserNotification()` has no if/else clause for ASSIGNMENT_UPDATED
        })
      );

      // Create new assignments, assign contacts, and notify users
      const newAssignmentChunks = _.chunk(newAssignments, CHUNK_SIZE);
      await Promise.all(
        newAssignmentChunks.map(async chunk => {
          // TODO - MySQL Specific. Must not do a bulk insert in order to be MySQL compatible
          const assignmentIds = await Promise.all(
            chunk.map(async directive => {
              const assignmentIds = await trx("assignment")
                .insert([directive.assignment])
                .returning("id");
              return assignmentIds[0];
            })
          );

          // const assignmentIds = await r.knex('assignment')
          //   .transacting(trx)
          //   .insert(assignmentInserts)
          //   .returning('id')

          const updatedChunk = await Promise.all(
            assignmentIds.map(async (assignmentId, index) => {
              // TODO - MySQL Specific. We have to do this because MySQL does not support returning multiple columns from a bulk insert
              let { contactsToAssign, assignment } = chunk[index];
              assignment.id = assignmentId;
              return { assignment, contactsToAssign };
            })
          );
          if (!dynamic) {
            for (let directive of updatedChunk) {
              await assignContacts(directive);
            }
            // await Promise.all(updatedChunk.map(async directive => await assignContacts(directive)))
            // Original MySQL compatible way it was written doesn't work sequentially
            // since all of the selects run at the same time, and select the same contacts for updating
            // Potential solutions to make it concurrent:
            // 1. Skip locked
            // 2. With select limit

            // Wait to send notification until all contacts have been updated
            await Promise.all(
              updatedChunk.map(async directive => {
                const { assignment } = directive;
                await sendUserNotification({
                  type: Notifications.ASSIGNMENT_CREATED,
                  assignment
                });
              })
            );
          }
        })
      );

      // dynamic assignments, having zero initially is ok
      if (!campaign.use_dynamic_assignment) {
        // TODO - MySQL Specific. Look up in separate query as MySQL does not support LIMIT within subquery
        const assignmentIds = await trx("assignment")
          .select("assignment.id as id")
          .where("assignment.campaign_id", cid)
          .leftJoin(
            "campaign_contact",
            "assignment.id",
            "campaign_contact.assignment_id"
          )
          .groupBy("assignment.id")
          .havingRaw("COUNT(campaign_contact.id) = 0")
          .map(result => result.id);

        await trx("assignment")
          .delete()
          .whereIn("id", assignmentIds);
      }

      if (job.id) {
        await r
          .knex("job_request")
          .delete()
          .where({ id: job.id });
      }
    };

    execute()
      .then(trx.commit)
      .catch(error => {
        logger.error("Rolling back!", error);
        trx.rollback(error);
      });
  });
}

/**
 * Fetch necessary job data from database.
 * @param {object} job The export job object to fetch data for. Must have payload, campaign_id, and requester properties.
 */
const fetchExportData = async job => {
  const { campaign_id: campaignId, payload: rawPayload } = job;
  const { requester: requesterId } = JSON.parse(rawPayload);
  const { title: campaignTitle } = await r
    .reader("campaign")
    .first("title")
    .where({ id: campaignId });

  const { email: notificationEmail } = await r
    .reader("user")
    .first("email")
    .where({ id: requesterId });

  const interactionSteps = await r
    .reader("interaction_step")
    .select("*")
    .where({ campaign_id: campaignId });

  const assignments = await r
    .reader("assignment")
    .where("campaign_id", campaignId)
    .join("user", "user_id", "user.id")
    .select(
      "assignment.id as id",
      "user.first_name",
      "user.last_name",
      "user.email",
      "user.cell",
      "user.assigned_cell"
    );

  return {
    campaignId,
    campaignTitle,
    notificationEmail,
    interactionSteps,
    assignments
  };
};

const stepHasQuestion = step => step.question && step.question.trim() !== "";

/**
 * Returns map from interaction step ID --> question text (deduped where appropriate).
 * @param {object[]} interactionSteps Array of interaction steps to work on.
 */
const getUniqueQuestionsByStepId = interactionSteps => {
  const questionSteps = interactionSteps.filter(stepHasQuestion);
  const duplicateQuestions = _.groupBy(questionSteps, step => step.question);

  return Object.keys(duplicateQuestions).reduce(
    (allQuestions, questionText) => {
      const steps = duplicateQuestions[questionText];
      const newUniqueQuestions =
        steps.length > 1
          ? steps.reduce(
              (collector, step, index) =>
                Object.assign(collector, {
                  [step.id]: `${questionText}_${index + 1}`
                }),
              {}
            )
          : { [steps[0].id]: questionText };

      return Object.assign(allQuestions, newUniqueQuestions);
    },
    {}
  );
};

const processContactsChunk = async (
  campaignId,
  campaignTitle,
  questionsById,
  lastContactId = 0
) => {
  const { rows } = await r.reader.raw(
    `
      with campaign_contacts as (
        select *
        from campaign_contact
        where
          campaign_id = ?
          and id > ?
        order by
          campaign_contact.id asc
        limit ?
      )
      select
        campaign_contacts.*,
        zip_code.city,
        zip_code.state,
        question_response.interaction_step_id,
        question_response.value,
        tags.tag_titles
      from campaign_contacts
      left join question_response
        on question_response.campaign_contact_id = campaign_contacts.id
      left join zip_code
        on zip_code.zip = campaign_contacts.zip
      left join (
          select 
            campaign_contact_tag.campaign_contact_id,
            array_agg(tag.title) as tag_titles
          from campaign_contact_tag
          join tag
            on campaign_contact_tag.tag_id = tag.id
          group by campaign_contact_tag.campaign_contact_id
        ) as tags
        on tags.campaign_contact_id = campaign_contacts.id
        order by campaign_contacts.id asc
      ;
    `,
    [campaignId, lastContactId, CHUNK_SIZE]
  );

  if (rows.length === 0) return false;

  lastContactId = rows[rows.length - 1].id;

  const rowsByContactId = _.groupBy(rows, row => row.id);
  const contacts = Object.keys(rowsByContactId).map(contactId => {
    // Use the first row for all the common campaign contact fields
    const contact = rowsByContactId[contactId][0];
    const contactRow = {
      campaignId,
      campaign: campaignTitle,
      "contact[firstName]": contact.first_name,
      "contact[lastName]": contact.last_name,
      "contact[cell]": contact.cell,
      "contact[zip]": contact.zip,
      "contact[city]": contact.city || null,
      "contact[state]": contact.state || null,
      "contact[optOut]": contact.is_opted_out,
      "contact[messageStatus]": contact.message_status,
      "contact[external_id]": contact.external_id
    };

    // Append columns for custom fields
    const customFields = JSON.parse(contact.custom_fields);
    Object.keys(customFields).forEach(fieldName => {
      contactRow[`contact[${fieldName}]`] = customFields[fieldName];
    });

    // Append columns for question responses
    Object.keys(questionsById).forEach(stepId => {
      const questionText = questionsById[stepId];
      const response = rowsByContactId[contactId].find(
        response => parseInt(response.interaction_step_id) == parseInt(stepId)
      );

      const responseValue = response ? response.value : "";
      contactRow[`question[${questionText}]`] = responseValue;
    });

    contactRow["tags"] = contact.tag_titles;

    return contactRow;
  });

  return { lastContactId, contacts };
};

const processMessagesChunk = async (campaignId, lastContactId = 0) => {
  const { rows } = await r.reader.raw(
    `
      with campaign_contact_ids as (
        select id
        from campaign_contact
        where
          campaign_id = ?
          and id > ?
          and exists (
            select 1
            from message
            where campaign_contact_id = campaign_contact.id
          )
        order by
          id asc
        limit ?
      )
      select
        message.campaign_contact_id,
        message.assignment_id,
        message.user_number,
        message.contact_number,
        message.is_from_contact,
        message.text,
        message.send_status,
        message.created_at,
        public.user.first_name,
        public.user.last_name,
        public.user.email,
        public.user.cell as user_cell
      from message
      join campaign_contact_ids
        on campaign_contact_ids.id = message.campaign_contact_id
      left join public.user
        on message.user_id = public.user.id
      order by
        campaign_contact_id asc,
        message.created_at asc
      ;
    `,
    [campaignId, lastContactId, CHUNK_SIZE]
  );

  if (rows.length === 0) return false;

  lastContactId = rows[rows.length - 1].campaign_contact_id;

  const messages = rows.map(message => ({
    assignmentId: message.assignment_id,
    userNumber: message.user_number,
    contactNumber: message.contact_number,
    isFromContact: message.is_from_contact,
    sendStatus: message.send_status,
    attemptedAt: moment(message.created_at).toISOString(),
    text: message.text,
    campaignId,
    "texter[firstName]": message.first_name,
    "texter[lastName]": message.last_name,
    "texter[email]": message.email,
    "texter[cell]": message.user_cell
  }));

  return { lastContactId, messages };
};

const exporters = {
  s3: s3,
  "gs-json": gsJson
};

const uploadToCloud = async (key, payload) => {
  const { upload, getDownloadUrl } = exporters[config.EXPORT_DRIVER];

  await upload(config.AWS_S3_BUCKET_NAME, key, payload);
  return getDownloadUrl(config.AWS_S3_BUCKET_NAME, key);
};

const deleteJob = async (jobId, retries = 0) => {
  try {
    await r
      .knex("job_request")
      .where({ id: jobId })
      .del();
  } catch (err) {
    if (retries < 5) {
      await deleteJob(jobId, retries + 1);
    } else {
      logger.error(`Could not delete job. Err: ${err.message}`);
    }
  }
};

export async function exportCampaign(job) {
  let campaignId = undefined,
    campaignTitle = undefined,
    notificationEmail = undefined,
    interactionSteps = undefined,
    assignments = undefined;

  try {
    ({
      campaignId,
      campaignTitle,
      notificationEmail,
      interactionSteps,
      assignments
    } = await fetchExportData(job));
  } catch (exc) {
    logger.error("Error fetching export data:", exc);
    return;
  }

  const uniqueQuestionsByStepId = getUniqueQuestionsByStepId(interactionSteps);

  // Message rows
  let messageRows = [];
  let lastContactId;
  try {
    let chunkMessageResult = undefined;
    lastContactId = 0;
    while (
      (chunkMessageResult = await processMessagesChunk(
        campaignId,
        lastContactId
      ))
    ) {
      lastContactId = chunkMessageResult.lastContactId;
      messageRows = messageRows.concat(chunkMessageResult.messages);
    }
  } catch (exc) {
    logger.error("Error building message rows:", exc);
  }

  // Contact rows
  let contactRows = [];
  try {
    let chunkContactResult = undefined;
    lastContactId = 0;
    while (
      (chunkContactResult = await processContactsChunk(
        campaignId,
        campaignTitle,
        uniqueQuestionsByStepId,
        lastContactId
      ))
    ) {
      lastContactId = chunkContactResult.lastContactId;
      contactRows = contactRows.concat(chunkContactResult.contacts);
    }
  } catch (exc) {
    logger.error("Error building campaign contact rows:", exc);
  }

  // Create the CSV paylaods
  let campaignsCsv = undefined,
    messagesCsv = undefined;
  try {
    campaignsCsv = Papa.unparse(contactRows);
    messagesCsv = Papa.unparse(messageRows);
  } catch (exc) {
    logger.error("Error building CSVs:", exc);
  }

  const validAwsCredentials =
    config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY;
  const valudGcpCredentials = !!config.GOOGLE_APPLICATION_CREDENTIALS;
  const validS3Config =
    config.EXPORT_DRIVER === "s3" &&
    (validAwsCredentials || config.AWS_ACCESS_AVAILABLE);
  const validGcpHmacConfig =
    config.EXPORT_DRIVER === "gs" && validAwsCredentials;
  const validGcpConfig =
    config.EXPORT_DRIVER === "gs-json" && valudGcpCredentials;

  if (validS3Config || validGcpHmacConfig || validGcpConfig) {
    // Attempt upload to cloud storage
    const objectKeyPrefix = config.AWS_S3_KEY_PREFIX;
    const safeTitle = campaignTitle.replace(/ /g, "_").replace(/\//g, "_");
    const timestamp = moment().format("YYYY-MM-DD-HH-mm-ss");
    const campaignContactsKey = `${objectKeyPrefix}${safeTitle}-${timestamp}.csv`;
    const messagesKey = `${campaignContactsKey}-messages.csv`;
    try {
      const [campaignExportUrl, campaignMessagesExportUrl] = await Promise.all([
        uploadToCloud(campaignContactsKey, campaignsCsv),
        uploadToCloud(messagesKey, messagesCsv)
      ]);
      await sendEmail({
        to: notificationEmail,
        subject: `Export ready for ${campaignTitle}`,
        text:
          `Your Spoke exports are ready! These URLs will be valid for 24 hours.` +
          `    Campaign export: ${campaignExportUrl}` +
          `    Message export: ${campaignMessagesExportUrl}`
      }).catch(err => {
        logger.error(err);
        logger.info(`Campaign Export URL - ${campaignExportUrl}`);
        logger.info(
          `Campaign Messages Export URL - ${campaignMessagesExportUrl}`
        );
      });
      logger.info(`Successfully exported ${campaignId}`);
    } catch (err) {
      logger.error("Error uploading to cloud storage", err);

      await sendEmail({
        to: notificationEmail,
        subject: `Export failed for ${campaignTitle}`,
        text: `Your Spoke exports failed... please try again later.
        Error: ${err.message}`
      });
    }
  } else {
    logger.debug("Would have saved the following to cloud storage:");
    logger.debug(campaignsCsv);
    logger.debug(messagesCsv);
  }

  // Attempt to delete job ("why would a job ever _not_ have an id?" - bchrobot)
  if (job.id) {
    await deleteJob(job.id);
  } else {
    logger.debug(job);
  }
}

// add an in-memory guard that the same messages are being sent again and again
// not related to stale filter
let pastMessages = [];

export async function sendMessages(queryFunc, defaultStatus) {
  try {
    await knex.transaction(async trx => {
      let messages = [];
      try {
        let messageQuery = trx("message")
          .forUpdate()
          .where({ send_status: defaultStatus || "QUEUED" });

        if (queryFunc) {
          messageQuery = queryFunc(messageQuery);
        }

        messages = await messageQuery.orderBy("created_at");
      } catch (err) {
        // Unable to obtain lock on these rows meaning another process must be
        // sending them. We will exit gracefully in that case.
        trx.rollback();
        return;
      }

      try {
        for (let index = 0; index < messages.length; index++) {
          let message = messages[index];
          if (pastMessages.indexOf(message.id) !== -1) {
            throw new Error(
              "Encountered send message request of the same message." +
                " This is scary!  If ok, just restart process. Message ID: " +
                message.id
            );
          }
          message.service = message.service || config.DEFAULT_SERVICE;
          const service = serviceMap[message.service];
          logger.info(
            `Sending (${message.service}): ${message.user_number} -> ${
              message.contact_number
            }\nMessage: ${message.text}`
          );
          await service.sendMessage(message, trx);
          pastMessages.push(message.id);
          pastMessages = pastMessages.slice(-100); // keep the last 100
        }

        trx.commit();
      } catch (err) {
        logger.error("error sending messages:");
        logger.error(err);
        trx.rollback();
      }
    });
  } catch (err) {
    logger.error("sendMessages transaction errored:");
    logger.error(err);
  }
}

export async function handleIncomingMessageParts() {
  const messageParts = await r
    .reader("pending_message_part")
    .select("*")
    .limit(100);
  const messagePartsByService = {};
  messageParts.forEach(m => {
    if (m.service in serviceMap) {
      if (!(m.service in messagePartsByService)) {
        messagePartsByService[m.service] = [];
      }
      messagePartsByService[m.service].push(m);
    }
  });
  for (const serviceKey in messagePartsByService) {
    let allParts = messagePartsByService[serviceKey];
    const service = serviceMap[serviceKey];
    if (service.syncMessagePartProcessing) {
      // filter for anything older than ten minutes ago
      const tenMinutesAgo = new Date(new Date() - 1000 * 60 * 10);
      allParts = allParts.filter(part => part.created_at < tenMinutesAgo);
    }
    const allPartsCount = allParts.length;
    if (allPartsCount === 0) {
      continue;
    }

    const convertMessageParts = service.convertMessagePartsToMessage;
    const messagesToSave = [];
    let messagePartsToDelete = [];
    const concatMessageParts = {};
    for (let i = 0; i < allPartsCount; i++) {
      const part = allParts[i];
      const serviceMessageId = part.service_id;
      const savedCount = await r.parseCount(
        r
          .reader("message")
          .where({ service_id: serviceMessageId })
          .count()
      );
      const lastMessage = await getLastMessage({
        contactNumber: part.contact_number,
        service: serviceKey
      });
      const duplicateMessageToSaveExists = !!messagesToSave.find(
        message => message.service_id === serviceMessageId
      );
      if (!lastMessage) {
        logger.info("Received message part with no thread to attach to", part);
        messagePartsToDelete.push(part);
      } else if (savedCount > 0) {
        logger.info(
          `Found already saved message matching part service message ID ${
            part.service_id
          }`
        );
        messagePartsToDelete.push(part);
      } else if (duplicateMessageToSaveExists) {
        logger.info(
          `Found duplicate message to be saved matching part service message ID ${
            part.service_id
          }`
        );
        messagePartsToDelete.push(part);
      } else {
        const parentId = part.parent_id;
        if (!parentId) {
          messagesToSave.push(await convertMessageParts([part]));
          messagePartsToDelete.push(part);
        } else {
          if (part.service !== "nexmo") {
            throw new Error("should not have a parent ID for twilio");
          }
          const groupKey = [parentId, part.contact_number, part.user_number];
          const serviceMessage = JSON.parse(part.service_message);
          if (!concatMessageParts.hasOwnProperty(groupKey)) {
            const partCount = parseInt(serviceMessage["concat-total"], 10);
            concatMessageParts[groupKey] = Array(partCount).fill(null);
          }

          const partIndex = parseInt(serviceMessage["concat-part"], 10) - 1;
          if (concatMessageParts[groupKey][partIndex] !== null) {
            messagePartsToDelete.push(part);
          } else {
            concatMessageParts[groupKey][partIndex] = part;
          }
        }
      }
    }
    const keys = Object.keys(concatMessageParts);
    const keyCount = keys.length;

    for (let i = 0; i < keyCount; i++) {
      const groupKey = keys[i];
      const messageParts = concatMessageParts[groupKey];

      if (messageParts.filter(part => part === null).length === 0) {
        messagePartsToDelete = messagePartsToDelete.concat(messageParts);
        const message = await convertMessageParts(messageParts);
        messagesToSave.push(message);
      }
    }

    const messageCount = messagesToSave.length;
    for (let i = 0; i < messageCount; i++) {
      logger.info(
        "Saving message with service message ID",
        messagesToSave[i].service_id
      );
      await saveNewIncomingMessage(messagesToSave[i]);
    }

    const messageIdsToDelete = messagePartsToDelete.map(m => m.id);
    logger.info("Deleting message parts", messageIdsToDelete);
    await r
      .knex("pending_message_part")
      .whereIn("id", messageIdsToDelete)
      .del();
  }
}

// Temporary fix for orgless users
// See https://github.com/MoveOnOrg/Spoke/issues/934
// and job-processes.js
export async function fixOrgless() {
  if (config.FIX_ORGLESS) {
    const orgless = await r.knex
      .select("user.id")
      .from("user")
      .leftJoin("user_organization", "user.id", "user_organization.user_id")
      .whereNull("user_organization.id");
    orgless.forEach(async orglessUser => {
      await UserOrganization.save({
        user_id: orglessUser.id.toString(),
        organization_id: config.DEFAULT_ORG,
        role: "TEXTER"
      }).error(function(error) {
        // Unexpected errors
        logger.error("error on userOrganization save in orgless", error);
      });
      logger.error(
        "added orgless user " +
          user.id +
          " to organization " +
          config.DEFAULT_ORG
      );
    }); // forEach
  } // if
} // function

export async function clearOldJobs(delay) {
  // to clear out old stuck jobs
  const twoHoursAgo = new Date(new Date() - 1000 * 60 * 60 * 2);
  delay = delay || twoHoursAgo;
  return await r
    .knex("job_request")
    .where({ assigned: true })
    .where("updated_at", "<", delay)
    .delete();
}
