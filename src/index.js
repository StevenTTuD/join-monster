import assert from 'assert'

import * as queryAST from './query-ast-to-sql-ast'
import arrToConnection from './array-to-connection'
import AliasNamespace from './alias-namespace'
import nextBatch from './batch-planner'
import { buildWhereFunction, handleUserDbCall, compileSqlAST } from './util'


/*         _ _ _                _
  ___ __ _| | | |__   __ _  ___| | __
 / __/ _` | | | '_ \ / _` |/ __| |/ /
| (_| (_| | | | |_) | (_| | (__|   <
 \___\__,_|_|_|_.__/ \__,_|\___|_|\_\

     _       __ _       _ _   _
  __| | ___ / _(_)_ __ (_) |_(_) ___  _ __  ___
 / _` |/ _ \ |_| | '_ \| | __| |/ _ \| '_ \/ __|
| (_| |  __/  _| | | | | | |_| | (_) | | | \__ \
 \__,_|\___|_| |_|_| |_|_|\__|_|\___/|_| |_|___/
*/

/**
 * User-defined function that sends a raw SQL query to the databse.
 * @callback dbCall
 * @param {String} sql - The SQL generated by `joinMonster` for the batch fetching. Use it to get the data from your database.
 * @param {Function} [done] - An error-first "done" callback. Only define this parameter if you don't want to return a `Promise`.
 * @returns {Promise.<Array>} The raw data as a flat array of objects. Each object must represent a row from the result set.
 */
/**
 * Function for generating a SQL expression.
 * @callback sqlExpr
 * @param {String} tableAlias - The alias generated for this table. Already double-quoted.
 * @param {Object} args - The GraphQL arguments for this field.
 * @param {Object} context - An Object with arbitrary contextual information.
 * @param {Object} sqlASTNode - Join Monster object that abstractly represents this field. Also includes a reference to its parent node. This is useful, for example, if you need to access the parent field's table alias or GraphQL arguments.
 * @returns {String|Promise.<String>} The RAW expression interpolated into the query to compute the column. Unsafe user input must be scrubbed.
 */
/**
 * Function for generating a `WHERE` condition.
 * @callback where
 * @param {String} tableAlias - The alias generated for this table. Already double-quoted.
 * @param {Object} args - The GraphQL arguments for this field.
 * @param {Object} context - An Object with arbitrary contextual information.
 * @param {Object} sqlASTNode - Join Monster object that abstractly represents this field. Also includes a reference to its parent node. This is useful, for example, if you need to access the parent field's table alias or GraphQL arguments.
 * @returns {String|Promise.<String>} The RAW condition for the `WHERE` clause. Omitted if falsy value returned. Unsafe user input must be scrubbed.
 */
/**
 * Function for generating a `JOIN` condition.
 * @callback sqlJoin
 * @param {String} parentTable - The alias generated for the parent's table. Already double-quoted.
 * @param {String} childTable - The alias for the child's table. Already double-quoted.
 * @param {Object} args - The GraphQL arguments for this field.
 * @param {Object} context - An Object with arbitrary contextual information.
 * @returns {String} The RAW condition for the `LEFT JOIN`. Unsafe user input must be scrubbed.
 */
/**
 * Rather than a constant value, its a function to dynamically return the value.
 * @callback thunk
 * @param {Object} args - The GraphQL arguments for this field.
 * @param {Object} context - An Object with arbitrary contextual information.
 */

/* _                _
  | |__   ___  __ _(_)_ __    ___  ___  _   _ _ __ ___ ___
  | '_ \ / _ \/ _` | | '_ \  / __|/ _ \| | | | '__/ __/ _ \
  | |_) |  __/ (_| | | | | | \__ \ (_) | |_| | | | (_|  __/
  |_.__/ \___|\__, |_|_| |_| |___/\___/ \__,_|_|  \___\___|
              |___/
*/

/**
 * Takes the GraphQL resolveInfo and returns a hydrated Object with the data.
 * @param {Object} resolveInfo - Contains the parsed GraphQL query, schema definition, and more. Obtained from the fourth argument to the resolver.
 * @param {Object} context - An arbitrary object that gets passed to the `where` function. Useful for contextual infomation that influeces the  `WHERE` condition, e.g. session, logged in user, localization.
 * @param {dbCall} dbCall - A function that is passed the compiled SQL that calls the database and returns a promise of the data.
 * @param {Object} [options]
 * @param {Boolean} options.minify - Generate minimum-length column names in the results table.
 * @param {String} options.dialect - The dialect of SQL your Database uses. Currently `'pg'`, `'oracle'`, `'mariadb'`, `'mysql'`, and `'sqlite3'` are supported.
 * @returns {Promise.<Object>} The correctly nested data from the database.
 */
async function joinMonster(resolveInfo, context, dbCall, options = {}) {
  // we need to read the query AST and build a new "SQL AST" from which the SQL and
  const sqlAST = queryAST.queryASTToSqlAST(resolveInfo, options, context)
  const { sql, shapeDefinition } = await compileSqlAST(sqlAST, context, options)
  if (!sql) return {}

  // call their function for querying the DB, handle the different cases, do some validation, return a promise of the object
  let data = await handleUserDbCall(dbCall, sql, sqlAST, shapeDefinition)

  // if they are paginating, we'll get back an array which is essentially a "slice" of the whole data.
  // this function goes through the data tree and converts the arrays to Connection Objects
  data = arrToConnection(data, sqlAST)

  // so far we handled the first "batch". up until now, additional batches were ignored
  // this function recursively scanss the sqlAST and runs remaining batches
  await nextBatch(sqlAST, data, dbCall, context, options)

  // check for batch data
  if (Array.isArray(data)) {
    const childrenToCheck = sqlAST.children.filter(child => child.sqlBatch)
    return data.filter(d => {
      for (const child of childrenToCheck) {
        if (d[child.fieldName] == null) {
          return false
        }
      }
      return true
    })
  }

  return data
}


/**
 * A helper for resolving the Node type in Relay.
 * @param {String} typeName - The Name of the GraphQLObjectType
 * @param {Object} resolveInfo - Contains the parsed GraphQL query, schema definition, and more. Obtained from the fourth argument to the resolver.
 * @param {Object} context - An arbitrary object that gets passed to the `where` function. Useful for contextual infomation that influeces the  WHERE condition, e.g. session, logged in user, localization.
 * @param {where|Number|String|Array} condition - A value to determine the `where` function for searching the node. If it's a function, that function will be used as the `where` function. Otherwise, it is assumed to be the value(s) of the `primaryKey`. An array of values is needed for composite primary keys.
 * @param {Function} dbCall - A function that is passed the compiled SQL that calls the database and returns (a promise of) the data.
 * @param {Object} [options] - Same as `joinMonster` function's options.
 * @returns {Promise.<Object>} The correctly nested data from the database. The GraphQL Type is added to the "\_\_type\_\_" property, which is helpful for the `resolveType` function in the `nodeDefinitions` of **graphql-relay-js**.
 */
async function getNode(typeName, resolveInfo, context, condition, dbCall, options = {}) {
  // get the GraphQL type from the schema using the name
  const type = resolveInfo.schema._typeMap[typeName]
  assert(type, `Type "${typeName}" not found in your schema.`)
  assert(type._typeConfig.sqlTable, `joinMonster can't fetch a ${typeName} as a Node unless it has "sqlTable" tagged.`)

  // we need to determine what the WHERE function should be
  let where = buildWhereFunction(type, condition, options)

  // our getGraphQLType expects every requested field to be in the schema definition. "node" isn't a parent of whatever type we're getting, so we'll just wrap that type in an object that LOOKS that same as a hypothetical Node type
  const fakeParentNode = {
    _fields: {
      node: {
        type,
        name: type.name.toLowerCase(),
        where
      }
    }
  }
  const namespace = new AliasNamespace(options.minify)
  const sqlAST = {}
  const fieldNodes = resolveInfo.fieldNodes || resolveInfo.fieldASTs
  // uses the same underlying function as the main `joinMonster`
  queryAST.populateASTNode.call(resolveInfo, fieldNodes[0], fakeParentNode, sqlAST, namespace, 0, options)
  queryAST.pruneDuplicateSqlDeps(sqlAST, namespace)
  const { sql, shapeDefinition } = await compileSqlAST(sqlAST, context, options)
  const data = arrToConnection(await handleUserDbCall(dbCall, sql, sqlAST, shapeDefinition), sqlAST)
  await nextBatch(sqlAST, data, dbCall, context, options)
  if (!data) return data
  data.__type__ = type
  return data
}

joinMonster.getNode = getNode


// expose the package version for debugging
joinMonster.version = require('../package.json').version
export default joinMonster

