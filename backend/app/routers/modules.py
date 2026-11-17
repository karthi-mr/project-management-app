"""Modules: parts of a product made of several features. A milestone holds modules and features.

A module goes through the same stages as its features, one sign-off at a time. When every feature of
a module is signed off past a stage, the module follows on its own; signing off a module's stage signs
off the features at that stage with it. The rules live in signoff.py.
"""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import signoff
from ..database import get_db
from ..models import Feature, Milestone, ProjectModule, User, utcnow
from ..security import get_current_user
from ..serializers import module_out
from .planning import _check_owner
from .projects import can_manage, get_project, log_activity

router = APIRouter(prefix="/api", tags=["modules"])


class ModuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=20000)
    owner_id: int | None = None
    milestone_id: int | None = None
    start_date: date | None = None
    target_date: date | None = None
    stage: str = Field(default="proposed", max_length=20)
    feature_ids: list[int] = Field(default=[], max_length=500)


class ModuleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=20000)
    owner_id: int | None = None
    milestone_id: int | None = None
    start_date: date | None = None
    target_date: date | None = None
    stage: str | None = Field(default=None, max_length=20)
    feature_ids: list[int] | None = Field(default=None, max_length=500)


def _get_module(db: Session, module_id: int, user: User) -> ProjectModule:
    module = db.get(ProjectModule, module_id)
    if not module:
        raise HTTPException(404, "Module not found")
    get_project(db, module.project_id, user, section="features")
    return module


def _check_milestone(db: Session, project_id: int, milestone_id: int | None) -> None:
    if milestone_id is not None:
        milestone = db.get(Milestone, milestone_id)
        if not milestone or milestone.project_id != project_id or milestone.deleted_at is not None:
            raise HTTPException(422, "Milestone not found in this project")


def _check_dates(start: date | None, end: date | None) -> None:
    if start and end and end < start:
        raise HTTPException(422, "The target date cannot be before the start date")


def _set_features(db: Session, module: ProjectModule, feature_ids: list[int]) -> tuple[set, set]:
    """Make exactly these features the module's. Returns the modules and milestones they came from."""
    wanted = set(feature_ids)
    features = db.scalars(select(Feature).where(Feature.id.in_(wanted or [0]), Feature.project_id == module.project_id)).all()
    if len(features) != len(wanted):
        raise HTTPException(422, "Every feature must belong to this project")
    old_modules, old_milestones = set(), set()
    for feature in list(module.features):
        if feature.id not in wanted:
            feature.module_id = None  # it keeps its milestone
    for feature in features:
        if feature.module_id != module.id:
            old_modules.add(feature.module_id)
            old_milestones.add(feature.milestone_id)
            feature.module_id = module.id
            feature.milestone_id = module.milestone_id  # a feature in a module is part of the module's milestone
            feature.updated_at = utcnow()
    return old_modules, old_milestones


@router.get("/projects/{project_id}/modules")
def list_modules(project_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    get_project(db, project_id, user, section="features")
    modules = db.scalars(select(ProjectModule).where(ProjectModule.project_id == project_id).order_by(ProjectModule.id)).all()
    return [module_out(m) for m in modules]


@router.post("/projects/{project_id}/modules", status_code=201)
def create_module(project_id: int, data: ModuleIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    project = get_project(db, project_id, user, section="features")
    _check_owner(project, data.owner_id)
    _check_milestone(db, project.id, data.milestone_id)
    _check_dates(data.start_date, data.target_date)
    if data.stage not in signoff.FEATURE_STAGES:
        raise HTTPException(422, "Unknown stage")
    if not signoff.initial_stage_allowed(db, project, user, "module", data.stage):
        raise HTTPException(409, "New modules start as proposed or planned. Later stages need a sign-off.")
    module = ProjectModule(
        project_id=project.id, name=data.name.strip(), description=data.description, owner_id=data.owner_id,
        milestone_id=data.milestone_id, start_date=data.start_date, target_date=data.target_date, stage=data.stage,
    )
    db.add(module)
    db.flush()
    old_modules, old_milestones = _set_features(db, module, data.feature_ids)
    log_activity(db, project.id, user, f"added module “{module.name}”")
    db.flush()
    signoff.sync_modules(db, project, [*old_modules, module.id], user)
    signoff.sync_milestones(db, project, [*old_milestones, module.milestone_id], user)
    db.commit()
    db.refresh(module)
    return module_out(module)


@router.get("/modules/{module_id}")
def read_module(module_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return module_out(_get_module(db, module_id, user))


@router.patch("/modules/{module_id}")
def update_module(module_id: int, data: ModuleUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    module = _get_module(db, module_id, user)
    project = module.project
    fields = data.model_dump(exclude_unset=True)
    for name in ("name", "description", "stage"):
        if name in fields and fields[name] is None:
            del fields[name]
    if "owner_id" in fields:
        _check_owner(project, fields["owner_id"])
    touched_modules, touched_milestones = {module.id}, {module.milestone_id}
    if "milestone_id" in fields and fields["milestone_id"] != module.milestone_id:
        _check_milestone(db, project.id, fields["milestone_id"])
        module.milestone_id = fields["milestone_id"]
        for feature in module.features:  # its features move to the new milestone with it
            feature.milestone_id = module.milestone_id
        touched_milestones.add(module.milestone_id)
        log_activity(db, project.id, user, f"moved module “{module.name}” to {module.milestone.name if module.milestone else 'no milestone'}")
    if "feature_ids" in fields:
        old_modules, old_milestones = _set_features(db, module, fields["feature_ids"])
        touched_modules |= old_modules
        touched_milestones |= old_milestones | {module.milestone_id}
    new_stage = fields.pop("stage", None)
    if new_stage and new_stage != module.stage:
        # Enforces the lifecycle: one stage at a time, signed off by the owner or a manager.
        signoff.change_stage(db, project, user, "module", module, new_stage)
    for name in ("name", "description", "owner_id", "start_date", "target_date"):
        if name in fields:
            setattr(module, name, fields[name].strip() if name == "name" else fields[name])
    _check_dates(module.start_date, module.target_date)
    module.updated_at = utcnow()
    db.flush()
    signoff.sync_modules(db, project, touched_modules, user)
    signoff.sync_milestones(db, project, touched_milestones, user)
    db.commit()
    db.refresh(module)
    return module_out(module)


@router.delete("/modules/{module_id}", status_code=204)
def delete_module(module_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The module goes; its features stay, in the same milestone."""
    module = _get_module(db, module_id, user)
    if not (can_manage(module.project, user) or module.owner_id == user.id):
        raise HTTPException(403, "Only the module owner, project owner or an administrator can delete this")
    for feature in module.features:
        feature.module_id = None
    log_activity(db, module.project_id, user, f"deleted module “{module.name}”")
    db.delete(module)
    db.commit()
