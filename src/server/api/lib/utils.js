import humps from "humps";
import moment from "moment-timezone";

export function mapFieldsToModel(fields, model) {
  const resolvers = {};

  fields.forEach(field => {
    const snakeKey = humps.decamelize(field, { separator: "_" });
    // eslint-disable-next-line no-underscore-dangle
    if (model._schema._schema.hasOwnProperty(snakeKey)) {
      resolvers[field] = instance => instance[snakeKey];
    } else {
      // eslint-disable-next-line no-underscore-dangle
      throw new Error(
        `Could not find key ${snakeKey} in model ${model._schema._model._name}`
      );
    }
  });
  return resolvers;
}

export const capitalizeWord = word => {
  if (word) {
    return word[0].toUpperCase() + word.slice(1);
  }
  return "";
};

/**
 * Return the UTC offset in hours for a time zone.
 * @param {string} timezoneName The timezone name
 * @returns {number} UTC offset in hours
 */
export const getTzOffset = timezoneName => {
  // POSIX compatibility requires that the offsets are inverted
  // See: https://momentjs.com/timezone/docs/#/zone-object/offset/
  return moment.tz.zone(timezoneName).utcOffset(Date.now()) / -60;
};
