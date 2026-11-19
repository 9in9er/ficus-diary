import { Link, NavLink } from 'react-router-dom';
import Header from './Header';
import sproutIcon from '../i/icons/sprout.svg';
import hiddenIcon from '../i/icons/eye-off.svg';
import shovelIcon from '../i/icons/shovel.svg';
import trashIcon from '../i/icons/trash.svg';
import { ReactComponent as GridThreeIcon } from '../i/icons/grid-3-columns.svg';
import { ReactComponent as GridFourIcon } from '../i/icons/grid-4-columns.svg';
import { ReactComponent as GridEightIcon } from '../i/icons/grid-8-columns.svg';
import { ReactComponent as GridOneIcon } from '../i/icons/grid-1-column.svg';
import { ReactComponent as GridTwoIcon } from '../i/icons/grid-2-columns.svg';
import '../styles/PlantsToolbar.scss';

function ToolbarIcon({ name }) {
    const paths = {
        plus: <path d='M12 5v14M5 12h14' />,
        account: <><circle cx='12' cy='7' r='3.5' /><path d='M4.5 21v-2a7.5 7.5 0 0 1 15 0v2' /></>,
        chevron: <path d='m6 9 6 6 6-6' />,
    };
    return <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.7' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true' focusable='false'>{paths[name]}</svg>;
}

function GridControls({ mobile, value, onChange, compactColumns, regularColumns }) {
    const icons = { 2: GridTwoIcon, 3: GridThreeIcon, 4: GridFourIcon };
    const choices = mobile ? [
        { value: false, Icon: GridOneIcon, label: 'Обычный вид: 1 карточка в ряду' },
        { value: true, Icon: GridTwoIcon, label: 'Компактный вид: 2 карточки в ряду' },
    ] : [
        ...regularColumns.map((columns, index) => ({
            value: columns,
            Icon: icons[columns],
            label: `${index === 0 ? 'Крупные' : 'Средние'}: ${columns} карточки в ряду`,
        })),
        ...(compactColumns ? [{ value: 8, Icon: GridEightIcon, label: `Компактные: ${compactColumns} карточек в ряду` }] : []),
    ];
    return (
        <div className={`gridControls gridControls--${mobile ? 'mobile' : 'desktop'}`} role='group' aria-label={mobile ? 'Вид карточек на телефоне' : 'Вид карточек'}>
            {choices.map(({ value: choice, Icon, label }) => (
                <button key={String(choice)} type='button' className={`btn btnGridColumns ${value === choice ? 'btnGridColumns--active' : ''}`} aria-pressed={value === choice} aria-label={label} title={label} onClick={() => onChange(choice)}>
                    <Icon aria-hidden='true' focusable='false' />
                </button>
            ))}
        </div>
    );
}

export default function PlantsToolbar({
    isWishlist = false,
    count,
    trashCount,
    onAdd,
    searchQuery,
    setSearchQuery,
    sortMode,
    setSortMode,
    showOnlyHidden,
    setShowOnlyHidden,
    showOnlyNeedReplant,
    setShowOnlyNeedReplant,
    showTrash,
    setShowTrash,
    gridColumns,
    compactColumns = 8,
    regularColumns = [3, 4],
    setGridColumns,
    mobileCompact,
    setMobileCompact,
}) {
    const showAll = !showOnlyHidden && !showOnlyNeedReplant && !showTrash;
    return (
        <section className='plantsToolbar' aria-label={isWishlist ? 'Управление вишлистом' : 'Управление растениями'}>
            <div className='plantsToolbarHeader'>
                <Header showCount count={count} compact />
                <div className='plantsToolbarActions'>
                    <button className='btn btnAddPlant' type='button' onClick={onAdd} aria-label={isWishlist ? 'Добавить в вишлист' : 'Добавить растение'}><ToolbarIcon name='plus' />Добавить</button>
                    <Link className='btn btnAccount' to='/account' aria-label='Личный кабинет' title='Личный кабинет'><ToolbarIcon name='account' /></Link>
                </div>
            </div>
            <nav className='plantsNavigation' aria-label='Разделы растений'>
                <NavLink className='btn' to='/plants'>Мои растения</NavLink>
                <NavLink className='btn' to='/wishlist'>Вишлист</NavLink>
            </nav>
            <div className={`plantsToolbarControls ${isWishlist ? 'plantsToolbarControls--wishlist' : ''}`}>
                <div className='searchGroup'>
                    <input className='searchInput' type='search' placeholder='Поиск по названию...' aria-label='Поиск растений по названию' value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
                    {searchQuery && <button type='button' className='btn clearSearch' onClick={() => setSearchQuery('')} aria-label='Очистить поиск'>×</button>}
                </div>
                <div className='sortControls'>
                    <select aria-label='Сортировать растения' value={sortMode} onChange={(e) => setSortMode(e.target.value)}>
                        <option value='date'>Добавлены: новые → старые</option>
                        <option value='name'>Название: А → Я</option>
                        {!isWishlist && <option value='watering'>Полив: давно → недавно</option>}
                    </select>
                    <ToolbarIcon name='chevron' />
                </div>
                <GridControls value={gridColumns} onChange={setGridColumns} compactColumns={isWishlist ? null : compactColumns} regularColumns={regularColumns} />
                {!isWishlist && <GridControls mobile value={mobileCompact} onChange={setMobileCompact} />}
            </div>
            <div className='plantsToolbarFilters' role='group' aria-label='Фильтры растений'>
                <button className={`btn filterChip ${showAll ? 'filterChip--active' : ''}`} type='button' aria-pressed={showAll} onClick={() => { setShowOnlyHidden(false); setShowOnlyNeedReplant(false); setShowTrash(false); }}>
                    <img className='filterIcon' src={sproutIcon} alt='' /><span className='desktopLabel'>{isWishlist ? 'Все желания' : 'Все растения'}</span><span className='mobileLabel'>Все</span>
                </button>
                {!isWishlist && <><button className={`btn filterChip ${showOnlyHidden && !showTrash ? 'filterChip--active' : ''}`} type='button' aria-pressed={showOnlyHidden && !showTrash} onClick={() => { setShowOnlyHidden(!showOnlyHidden); setShowTrash(false); }}>
                    <img className='filterIcon' src={hiddenIcon} alt='' />Скрытые
                </button>
                <button className={`btn filterChip ${showOnlyNeedReplant && !showTrash ? 'filterChip--active' : ''}`} type='button' aria-pressed={showOnlyNeedReplant && !showTrash} onClick={() => { setShowOnlyNeedReplant(!showOnlyNeedReplant); setShowTrash(false); }}>
                    <img className='filterIcon' src={shovelIcon} alt='' /><span className='desktopLabel'>На пересадку</span><span className='mobileLabel'>Пересадка</span>
                </button></>}
                <div className='trashFilter'>
                    <button className={`btn filterChip ${showTrash ? 'filterChip--active' : ''}`} type='button' aria-pressed={showTrash} onClick={() => setShowTrash(!showTrash)}>
                        <img className='filterIcon' src={trashIcon} alt='' />Корзина · {trashCount}
                    </button>
                </div>
            </div>
        </section>
    );
}
