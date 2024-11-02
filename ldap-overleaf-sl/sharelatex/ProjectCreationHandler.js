const OError = require('@overleaf/o-error')
const metrics = require('@overleaf/metrics')
const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')

const fs = require('fs')
const fsExtra = require('fs-extra')
const path = require('path')
const { callbackify } = require('util')
const lodash = require('lodash')
const { ObjectId } = require('mongodb-legacy')

const Features = require('../../infrastructure/Features')
const { Doc } = require('../../models/Doc')
const { Folder } = require('../../models/Folder')
const { Project } = require('../../models/Project')
const { User } = require('../../models/User')

const ProjectDeleter = require('./ProjectDeleter')
const ProjectDetailsHandler = require('./ProjectDetailsHandler')
const ProjectEntityMongoUpdateHandler = require('./ProjectEntityMongoUpdateHandler')
const ProjectEntityUpdateHandler = require('./ProjectEntityUpdateHandler')
const ProjectRootDocManager = require('./ProjectRootDocManager')

const AnalyticsManager = require('../Analytics/AnalyticsManager')
const DocstoreManager = require('../Docstore/DocstoreManager')
const DocumentHelper = require('../Documents/DocumentHelper')
const DocumentUpdaterHandler = require('../DocumentUpdater/DocumentUpdaterHandler')
const FileStoreHandler = require('../FileStore/FileStoreHandler')
const HistoryManager = require('../History/HistoryManager')
const SplitTestHandler = require('../SplitTests/SplitTestHandler')
const { InvalidZipFileError } = require('../Uploads/ArchiveErrors')
const ArchiveManager = require('../Uploads/ArchiveManager')
const FileSystemImportManager = require('../Uploads/FileSystemImportManager')
const TpdsUpdateSender = require('../ThirdPartyDataStore/TpdsUpdateSender')
const TpdsProjectFlusher = require('../ThirdPartyDataStore/TpdsProjectFlusher')

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const templateProjectDir = Features.hasFeature('saas')
  ? 'example-project'
  : 'example-project-sp'

async function createBlankProject(
  ownerId,
  projectName,
  attributes = {},
  options
) {
  const isImport = attributes && attributes.overleaf
  const project = await _createBlankProject(
    ownerId,
    projectName,
    attributes,
    options
  )
  const segmentation = lodash.pick(attributes, [
    'fromV1TemplateId',
    'fromV1TemplateVersionId',
  ])
  Object.assign(segmentation, attributes.segmentation)
  segmentation.projectId = project._id
  if (isImport) {
    AnalyticsManager.recordEventForUserInBackground(
      ownerId,
      'project-imported',
      segmentation
    )
  } else {
    AnalyticsManager.recordEventForUserInBackground(
      ownerId,
      'project-created',
      segmentation
    )
  }
  return project
}

async function createProjectFromSnippet(ownerId, projectName, docLines) {
  const project = await _createBlankProject(ownerId, projectName)
  AnalyticsManager.recordEventForUserInBackground(ownerId, 'project-created', {
    projectId: project._id,
  })
  await _createRootDoc(project, ownerId, docLines)
  return project
}

async function createBasicProject(ownerId, projectName) {
  const project = await _createBlankProject(ownerId, projectName)

  const docLines = await _buildTemplate('mainbasic.tex', ownerId, projectName)
  await _createRootDoc(project, ownerId, docLines)

  AnalyticsManager.recordEventForUserInBackground(ownerId, 'project-created', {
    projectId: project._id,
  })

  return project
}

async function createExampleProject(ownerId, projectName) {
  const template_path = "/var/lib/overleaf/template_ecl.zip"
  const project = await _createProjectFromZipArchive(
    ownerId,
    projectName,
    template_path,
    function (error, project) {
      if (error != null) {
        logger.error(
          { err: error, filePath: template_path, fileName: projectName },
          'error uploading project'
        )
        if (error instanceof InvalidZipFileError) {
          return console.warn(error.message)
        } else {
          return console.warn('upload_failed')
        }
      }
    }
  )

  AnalyticsManager.recordEventForUserInBackground(ownerId, 'project-created', {
    projectId: project._id,
  })

  return project
}

async function _createBlankProject(
  ownerId,
  projectName,
  attributes = {},
  { skipCreatingInTPDS = false } = {}
) {
  metrics.inc('project-creation')
  const timer = new metrics.Timer('project-creation')
  await ProjectDetailsHandler.promises.validateProjectName(projectName)

  const rootFolder = new Folder({ name: 'rootFolder' })

  attributes.lastUpdatedBy = attributes.owner_ref = new ObjectId(ownerId)
  attributes.name = projectName
  const project = new Project(attributes)

  // Initialise the history unless the caller has overridden it in the attributes
  // (to allow scripted creation of projects without full project history)
  if (project.overleaf.history.id == null && !attributes.overleaf) {
    const historyId = await HistoryManager.promises.initializeProject(
      project._id
    )
    if (historyId != null) {
      project.overleaf.history.id = historyId
    }
  }

  // All the projects are initialised with Full Project History. This property
  // is still set for backwards compatibility: Server Pro requires all projects
  // have it set to `true` since SP 4.0
  project.overleaf.history.display = true

  if (Settings.currentImageName) {
    // avoid clobbering any imageName already set in attributes (e.g. importedImageName)
    if (!project.imageName) {
      project.imageName = Settings.currentImageName
    }
  }
  project.rootFolder[0] = rootFolder
  const user = await User.findById(ownerId, {
    'ace.spellCheckLanguage': 1,
    _id: 1,
  })
  project.spellCheckLanguage = user.ace.spellCheckLanguage
  const historyRangesSupportAssignment =
    await SplitTestHandler.promises.getAssignmentForUser(
      user._id,
      'history-ranges-support'
    )
  if (historyRangesSupportAssignment.variant === 'enabled') {
    project.overleaf.history.rangesSupportEnabled = true
  }
  await project.save()
  if (!skipCreatingInTPDS) {
    await TpdsUpdateSender.promises.createProject({
      projectId: project._id,
      projectName,
      ownerId,
      userId: ownerId,
    })
  }
  timer.done()
  return project
}

async function _createRootDoc(project, ownerId, docLines) {
  try {
    const { doc } = await ProjectEntityUpdateHandler.promises.addDoc(
      project._id,
      project.rootFolder[0]._id,
      'main.tex',
      docLines,
      ownerId,
      null
    )
    await ProjectEntityUpdateHandler.promises.setRootDoc(project._id, doc._id)
  } catch (error) {
    throw OError.tag(error, 'error adding root doc when creating project')
  }
}

async function _buildTemplate(templateName, userId, projectName) {
  const user = await User.findById(userId, 'first_name last_name')

  const templatePath = path.join(
    __dirname,
    `/../../../templates/project_files/${templateName}`
  )
  const template = fs.readFileSync(templatePath)
  const data = {
    project_name: projectName,
    user,
    year: new Date().getUTCFullYear(),
    month: MONTH_NAMES[new Date().getUTCMonth()],
  }
  const output = lodash.template(template.toString())(data)
  return output.split('\n')
}

module.exports = {
  createBlankProject: callbackify(createBlankProject),
  createProjectFromSnippet: callbackify(createProjectFromSnippet),
  createBasicProject: callbackify(createBasicProject),
  createExampleProject: callbackify(createExampleProject),
  promises: {
    createBlankProject,
    createProjectFromSnippet,
    createBasicProject,
    createExampleProject,
  },
}


async function _createProjectFromZipArchive(ownerId, defaultName, zipPath) {
  const contentsPath = await _extractZip(zipPath)
  const { path, content } =
    await ProjectRootDocManager.promises.findRootDocFileFromDirectory(
      contentsPath
    )

  const projectName =
    DocumentHelper.getTitleFromTexContent(content || '') || defaultName
  const uniqueName = await _generateUniqueName(ownerId, projectName)
  const project = await createBlankProject(
    ownerId,
    uniqueName
  )
  try {
    await _initializeProjectWithZipContents(ownerId, project, contentsPath)

    if (path) {
      await ProjectRootDocManager.promises.setRootDocFromName(project._id, path)
    }
  } catch (err) {
    // no need to wait for the cleanup here
    ProjectDeleter.promises
      .deleteProject(project._id)
      .catch(err =>
        logger.error(
          { err, projectId: project._id },
          'there was an error cleaning up project after importing a zip failed'
        )
      )
    throw err
  }
  await fsExtra.remove(contentsPath)
  return project
}

async function _extractZip(zipPath) {
  const destination = path.join(
    path.dirname(zipPath),
    `${path.basename(zipPath, '.zip')}-${Date.now()}`
  )
  await ArchiveManager.promises.extractZipArchive(zipPath, destination)
  return destination
}

async function _generateUniqueName(ownerId, originalName) {
  const fixedName = ProjectDetailsHandler.fixProjectName(originalName)
  const uniqueName = await ProjectDetailsHandler.promises.generateUniqueName(
    ownerId,
    fixedName
  )
  return uniqueName
}

async function _initializeProjectWithZipContents(
  ownerId,
  project,
  contentsPath
) {
  const topLevelDir =
    await ArchiveManager.promises.findTopLevelDirectory(contentsPath)
  const importEntries =
    await FileSystemImportManager.promises.importDir(topLevelDir)
  const { fileEntries, docEntries } = await _createEntriesFromImports(
    project._id,
    importEntries
  )
  const projectVersion =
    await ProjectEntityMongoUpdateHandler.promises.createNewFolderStructure(
      project._id,
      docEntries,
      fileEntries
    )
  await _notifyDocumentUpdater(project, ownerId, {
    newFiles: fileEntries,
    newDocs: docEntries,
    newProject: { version: projectVersion },
  })
  await TpdsProjectFlusher.promises.flushProjectToTpds(project._id)
}

async function _createEntriesFromImports(projectId, importEntries) {
  const fileEntries = []
  const docEntries = []
  for (const importEntry of importEntries) {
    switch (importEntry.type) {
      case 'doc': {
        const docEntry = await _createDoc(
          projectId,
          importEntry.projectPath,
          importEntry.lines
        )
        docEntries.push(docEntry)
        break
      }
      case 'file': {
        const fileEntry = await _createFile(
          projectId,
          importEntry.projectPath,
          importEntry.fsPath
        )
        fileEntries.push(fileEntry)
        break
      }
      default: {
        throw new Error(`Invalid import type: ${importEntry.type}`)
      }
    }
  }
  return { fileEntries, docEntries }
}

async function _createDoc(projectId, projectPath, docLines) {
  const docName = path.basename(projectPath)
  const doc = new Doc({ name: docName })
  await DocstoreManager.promises.updateDoc(
    projectId.toString(),
    doc._id.toString(),
    docLines,
    0,
    {}
  )
  return { doc, path: projectPath, docLines: docLines.join('\n') }
}

async function _createFile(projectId, projectPath, fsPath) {
  const fileName = path.basename(projectPath)
  const { fileRef, url } = await FileStoreHandler.promises.uploadFileFromDisk(
    projectId,
    { name: fileName },
    fsPath
  )
  return { file: fileRef, path: projectPath, url }
}

async function _notifyDocumentUpdater(project, userId, changes) {
  const projectHistoryId =
    project.overleaf && project.overleaf.history && project.overleaf.history.id
  await DocumentUpdaterHandler.promises.updateProjectStructure(
    project._id,
    projectHistoryId,
    userId,
    changes,
    null
  )
}